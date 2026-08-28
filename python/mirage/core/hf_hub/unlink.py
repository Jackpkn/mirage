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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.context import invalidate_after_unlink, invalidate_ancestors
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_hub.commit import commit
from mirage.core.hf_hub.lookup import key_of, lookup
from mirage.core.hf_hub.write import drop_tree
from mirage.types import PathSpec
from mirage.utils.errors import eisdir, enoent
from mirage.utils.key_prefix import mount_prefix_of


async def unlink(accessor: HfHubAccessor,
                 path: PathSpec,
                 index: IndexCacheStore = NULL_INDEX) -> None:
    """Remove one file, as a commit on the mount's revision.

    The listing is consulted first so removing something that is not
    there reports ENOENT rather than the Hub's own wording, and so a
    directory operand reports EISDIR rather than silently deleting a
    subtree the caller did not name recursively.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the file to remove.
        index (IndexCacheStore): the mount's index.

    Raises:
        FileNotFoundError: nothing exists at the path.
        IsADirectoryError: the path names a directory.
    """
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    rel = path.mount_path.strip("/")
    found = await lookup(accessor, index, prefix, key_of(prefix, rel))
    if not found.exists:
        raise enoent(path.virtual)
    if found.is_dir:
        raise eisdir(path.virtual)
    await commit(accessor, deletions=[accessor.repo_path(rel)])
    drop_tree(accessor)
    await invalidate_after_unlink(path)
    await invalidate_ancestors(path)
