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

from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mem0.client import get_memory
from mirage.core.mem0.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _resolve_memory(
    accessor: Mem0Accessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> dict[str, Any]:
    match = detect_scope(path)
    if match.kind != "memory":
        raise enoent(path)
    lookup = await index.get(path.virtual)
    cached = (lookup.entry.extra.get("memory")
              if lookup.entry is not None else None)
    if isinstance(cached, dict):
        return cached
    return await get_memory(accessor.client, match.slots["memory_id"], path)


async def _read_memory(accessor: Mem0Accessor, match: ScopeMatch,
                       path: PathSpec, index: IndexCacheStore) -> bytes:
    memory = await _resolve_memory(accessor, path, index)
    return json_bytes(memory)


read = make_read(detect_scope, {"memory": _read_memory})


async def read_stream(
    accessor: Mem0Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    """Stream a memory as full JSON bytes (used by jq).

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        path (PathSpec): the memory file path.
        index (IndexCacheStore): index cache.
    """
    memory = await _resolve_memory(accessor, path, index)
    yield json_bytes(memory)
