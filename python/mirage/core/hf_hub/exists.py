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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_hub.stat import stat
from mirage.types import PathSpec


async def exists(
    accessor: HfHubAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bool:
    """Whether anything exists at a path.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the path to probe.
        index (IndexCacheStore): the mount's index.

    Returns:
        bool: True for a file or a directory, False for an absence.
    """
    try:
        await stat(accessor, path, index)
    except FileNotFoundError:
        return False
    return True
