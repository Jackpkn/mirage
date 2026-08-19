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

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.postgres import client
from mirage.core.postgres._schema_json import (build_database_json,
                                               build_entity_schema_json)
from mirage.core.postgres.scope import detect_scope
from mirage.core.postgres.semantic import build_entity_semantic_json
from mirage.types import PathSpec


def _entity_kind(match: ScopeMatch) -> str:
    return "table" if match.slots["kind"] == "tables" else "view"


async def _read_database_json(accessor: PostgresAccessor, match: ScopeMatch,
                              path: PathSpec, index: IndexCacheStore) -> bytes:
    doc = await build_database_json(accessor)
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_schema(accessor: PostgresAccessor, match: ScopeMatch,
                              path: PathSpec, index: IndexCacheStore) -> bytes:
    doc = await build_entity_schema_json(accessor, match.slots["schema"],
                                         match.slots["entity"],
                                         _entity_kind(match))
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_semantic(accessor: PostgresAccessor, match: ScopeMatch,
                                path: PathSpec,
                                index: IndexCacheStore) -> bytes:
    doc = await build_entity_semantic_json(accessor, match.slots["schema"],
                                           match.slots["entity"],
                                           _entity_kind(match))
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_rows(accessor: PostgresAccessor, match: ScopeMatch,
                            path: PathSpec, index: IndexCacheStore,
                            limit: int | None, offset: int | None) -> bytes:
    return await _read_rows(accessor,
                            match.slots["schema"],
                            match.slots["entity"],
                            kind=match.slots["kind"],
                            limit=limit,
                            offset=offset)


async def _read_rows(accessor: PostgresAccessor, schema: str, entity: str, *,
                     kind: str, limit: int | None,
                     offset: int | None) -> bytes:
    cfg = accessor.config
    if limit is None and offset is None:
        pool = await accessor.pool()
        async with pool.acquire() as conn:
            rows, width = await client.estimate_size(conn, schema, entity)
        if (rows > cfg.max_read_rows
                or rows * max(width, 1) > cfg.max_read_bytes):
            raise ValueError(
                f"{schema}/{kind}/{entity}/rows.jsonl too large to read "
                f"entirely: ~{rows} rows / ~{rows * max(width, 1)} bytes "
                f"(thresholds: {cfg.max_read_rows} rows / "
                f"{cfg.max_read_bytes} bytes); use head, tail, wc, grep, "
                f"or pass limit/offset")
        effective_limit = rows or cfg.default_row_limit
        effective_offset = 0
    else:
        effective_limit = limit if limit is not None else cfg.default_row_limit
        effective_offset = offset or 0

    pool = await accessor.pool()
    async with pool.acquire() as conn:
        data = await client.fetch_rows(conn,
                                       schema,
                                       entity,
                                       limit=effective_limit,
                                       offset=effective_offset)
    if not data:
        return b""
    lines = [orjson.dumps(r, default=str).decode() for r in data]
    return ("\n".join(lines) + "\n").encode()


read = make_read(detect_scope, {
    "database_json": _read_database_json,
    "entity_schema": _read_entity_schema,
    "entity_semantic": _read_entity_semantic,
},
                 windowed={"entity_rows": _read_entity_rows})
