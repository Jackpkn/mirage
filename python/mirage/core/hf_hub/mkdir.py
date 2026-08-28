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
from mirage.types import PathSpec


async def mkdir(accessor: HfHubAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    """Create a directory, which on a git tree means create nothing.

    A git tree records no empty directories -- a directory exists exactly
    while some path under it does -- so there is no marker to write and
    nothing to ask the Hub for. This is the same no-op the bucket backend
    performs, but for a different reason: there OpenDAL refuses a
    directory marker client-side, here the format simply has no such
    thing to store.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the directory to create.
        parents (bool): whether missing parents may be created, which
            makes no difference when nothing is created either way.
    """
    del accessor, path, parents
