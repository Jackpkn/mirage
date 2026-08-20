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

import base64
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.read import Reader, make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.lancedb.query import row_record
from mirage.core.lancedb.render import render_card
from mirage.core.lancedb.scope import detect_for, table_of
from mirage.types import JsonValue, PathSpec
from mirage.utils.errors import enoent


async def _row_of(accessor: LanceDBAccessor, match: ScopeMatch,
                  virtual: str) -> dict[str, Any]:
    config = accessor.config
    row = await row_record(accessor, table_of(config, match), config.id_column,
                           match.slots["row_id"])
    if row is None:
        raise enoent(virtual)
    return row


def _blob_bytes(value: JsonValue) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return base64.b64decode(value)
    raise ValueError("blob column is not bytes or base64 str")


async def _read_card(accessor: LanceDBAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    row = await _row_of(accessor, match, path.virtual)
    return render_card(row, accessor.config)


async def _read_blob(accessor: LanceDBAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    config = accessor.config
    if not config.blob_column:
        raise enoent(path)
    row = await _row_of(accessor, match, path.virtual)
    return _blob_bytes(row.get(config.blob_column))


READERS: dict[str, Reader[LanceDBAccessor]] = {
    "row_card": _read_card,
    "row_blob": _read_blob,
}


def _build(accessor: LanceDBAccessor) -> Callable[..., Awaitable[bytes]]:
    return make_read(detect_for(accessor), READERS)


read_for = per_accessor(_build)


async def read(
    accessor: LanceDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    return await read_for(accessor)(accessor, path, index)
