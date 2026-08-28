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

import time

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.hf_hub.commit import Addition, commit
from mirage.observe.context import record
from mirage.types import PathSpec


def drop_tree(accessor: HfHubAccessor) -> None:
    """Forget the cached listing after a commit changed it.

    The accessor's tree *is* the mount's listing, so a write that does
    not clear it leaves find, du and every no-index read answering from
    the repository as it was before the commit.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
    """
    accessor.tree = {}
    accessor.tree_loaded = False
    accessor.rows_cache = None


async def write_bytes(accessor: HfHubAccessor, path: PathSpec,
                      data: bytes) -> None:
    """Add or replace one file, as a commit on the mount's revision.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the target path.
        data (bytes): the file content.
    """
    start_ms = int(time.monotonic() * 1000)
    repo_path = accessor.repo_path(path.mount_path)
    await commit(accessor, additions=[Addition(path=repo_path, data=data)])
    record("write", path.virtual, accessor.RESOURCE_NAME, len(data), start_ms)
    drop_tree(accessor)
    await invalidate_after_write(path)
    await invalidate_ancestors(path)
