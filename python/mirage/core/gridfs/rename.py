# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Any

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.core.gridfs._client import (_key, _prefix, delete_all, files_coll,
                                        latest_file, prefix_query)
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _rename_prefix(accessor: GridFSAccessor, src_pfx: str,
                         dst_pfx: str) -> bool:
    """Retag every revision under ``src_pfx`` to sit under ``dst_pfx``.

    A directory is a filename prefix plus the zero-byte ``key/`` marker
    mkdir writes, and the prefix query returns both, so one pass moves the
    marker and the whole subtree together.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        src_pfx (str): source key prefix, trailing slash included.
        dst_pfx (str): destination key prefix, trailing slash included.

    Returns:
        bool: whether any revision was found under the source prefix.
    """
    files = files_coll(accessor)
    docs: list[dict[str, Any]] = []
    async for doc in files.find(prefix_query(src_pfx),
                                projection={
                                    "_id": 1,
                                    "filename": 1
                                }):
        docs.append(doc)
    if not docs:
        return False
    if dst_pfx != src_pfx:
        # Read the source docs before clearing the destination: on a
        # self-directed move the two queries select the same revisions,
        # and deleting first would drop what the retag is about to move.
        await delete_all(accessor, prefix_query(dst_pfx))
    for doc in docs:
        await files.update_one({"_id": doc["_id"]}, {
            "$set": {
                "filename": f"{dst_pfx}{doc['filename'][len(src_pfx):]}"
            }
        })
    return True


async def rename(accessor: GridFSAccessor, src_spec: PathSpec,
                 dst_spec: PathSpec) -> None:
    """Relocate a file or a whole directory prefix.

    Server-side: retag every revision's filename instead of copying bytes,
    so the whole revision history moves with the file. A directory owns no
    revision of its own, so an absent source file falls through to the
    prefix retag; a source that is neither is ENOENT.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        src_spec (PathSpec): source path.
        dst_spec (PathSpec): destination path.
    """
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    src_key = _key(src, config)
    dst_key = _key(dst, config)
    if await latest_file(accessor, src_key) is None:
        if not await _rename_prefix(accessor, _prefix(src, config),
                                    _prefix(dst, config)):
            raise enoent(src_spec.virtual)
    else:
        if dst_key != src_key:
            await delete_all(accessor, {"filename": dst_key})
        await files_coll(accessor).update_many({"filename": src_key},
                                               {"$set": {
                                                   "filename": dst_key
                                               }})
    await invalidate_after_unlink(dst_spec)
    await invalidate_after_unlink(src_spec)
