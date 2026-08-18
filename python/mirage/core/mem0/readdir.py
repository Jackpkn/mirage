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

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import RouteMatch
from mirage.core.mem0.client import get_all_memories
from mirage.core.mem0.scope import detect_scope
from mirage.core.render.json import json_bytes


async def _list_memories(accessor: Mem0Accessor,
                         match: RouteMatch) -> list[tuple[str, IndexEntry]]:
    memories = await get_all_memories(
        accessor.client,
        filters=accessor.config.scope_filter,
        page_size=accessor.config.default_page_size,
    )
    entries: list[tuple[str, IndexEntry]] = []
    for m in memories:
        body = json_bytes(m)
        memory_id = str(m["id"])
        filename = f"{memory_id}.json"
        entry = IndexEntry(
            id=memory_id,
            name=filename,
            resource_type="mem0/memory",
            vfs_name=filename,
            size=len(body),
            remote_time=m.get("updated_at") or m.get("created_at") or "",
            extra={"memory": m},
        )
        entries.append((filename, entry))
    return entries


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_memories},
    leaf_error="enotdir",
)
