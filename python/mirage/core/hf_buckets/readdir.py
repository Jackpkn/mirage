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

import logging
from functools import partial

from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hf_buckets.constants import SCOPE_ERROR
from mirage.types import PathSpec
from mirage.utils.errors import readdir_error
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def _is_file(accessor: HfBucketsAccessor, key: str) -> bool:
    try:
        md = await accessor.operator().stat(key.strip("/"))
    except NotFound:
        return False
    return md.mode != EntryMode.Dir


async def _is_dir(accessor: HfBucketsAccessor, key: str) -> bool:
    try:
        md = await accessor.operator().stat(key.strip("/") + "/")
    except NotFound:
        return False
    return md.mode == EntryMode.Dir


async def readdir(accessor: HfBucketsAccessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    target = path.directory if path.pattern else path.virtual
    if prefix and target.startswith(prefix):
        rest = target[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            target = rest or "/"
    virtual_key = (prefix + target if prefix else target).rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    list_path = target.strip("/")
    list_path = list_path + "/" if list_path else "/"
    op = accessor.operator()
    names: list[str] = []
    dir_keys: set[str] = set()
    sizes: dict[str, int | None] = {}
    try:
        async for entry in await op.list(list_path):
            relative = entry.path
            if not relative or relative == list_path:
                continue
            is_dir = relative.endswith("/")
            base = "/" + relative.rstrip("/")
            names.append(base)
            if is_dir:
                dir_keys.add(base)
            else:
                meta = entry.metadata
                sizes[base] = meta.content_length if meta else None
    except NotFound as exc:
        raise await readdir_error(path, target, partial(_is_file, accessor),
                                  partial(_is_dir, accessor)) from exc
    if not names and target.strip("/"):
        # An empty listing is ambiguous here in a way it is not on s3: hf
        # can store no directory marker at all (see mkdir), so "no keys
        # under this prefix" covers both a path the repo does not have and
        # a directory whose last file was just removed. Only the ENOTDIR
        # half of the walk is provable, and it is the half GNU disagrees
        # with us about: `ls /hf/a.txt/x` must not render an empty
        # directory when `a.txt` is a stored key. ENOENT is dropped rather
        # than guessed, so an emptied directory still lists as empty.
        error = await readdir_error(path, target, partial(_is_file, accessor),
                                    partial(_is_dir, accessor))
        if isinstance(error, NotADirectoryError):
            raise error
    # The Hub tree API carries a size for every file (for LFS files it is
    # the object size, not the pointer's); when the lister omits the
    # metadata, one stat per affected file fills the gap so the index
    # never caches an unknown size.
    for base, size in sizes.items():
        if size is None:
            md = await op.stat(base.lstrip("/"))
            sizes[base] = md.content_length
    names = sorted(names)
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "hf_buckets readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    index_entries: list[tuple[str, IndexEntry]] = []
    for e in names:
        name = e.rsplit("/", 1)[-1]
        if e in dir_keys:
            entry_obj = IndexEntry(id=e, name=name, resource_type="folder")
        else:
            entry_obj = IndexEntry(id=e,
                                   name=name,
                                   resource_type="file",
                                   size=sizes.get(e))
        index_entries.append((name, entry_obj))
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
