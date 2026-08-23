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

import hashlib

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.postgres import client
from mirage.core.postgres.readdir import readdir
from mirage.core.postgres.scope import detect_scope
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


async def _schema_guard(accessor: PostgresAccessor, match: ScopeMatch,
                        virtual: str) -> None:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await client.list_schemas(conn, accessor.config.schemas)
    if match.slots["schema"] not in schemas:
        raise enoent(virtual)


async def _entity_guard(accessor: PostgresAccessor, match: ScopeMatch,
                        virtual: str) -> None:
    schema = match.slots["schema"]
    kind = match.slots["kind"]
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            names = await client.list_tables(conn, schema)
        else:
            views = await client.list_views(conn, schema)
            mviews = await client.list_matviews(conn, schema)
            names = sorted(set(views) | set(mviews))
    if match.slots["entity"] not in names:
        raise enoent(virtual)


def _schema_extra(match: ScopeMatch) -> dict[str, str]:
    return {"schema": match.slots["schema"]}


def _kind_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "schema": match.slots["schema"],
        "kind": match.slots["kind"],
    }


def _entity_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "schema": match.slots["schema"],
        "kind": match.slots["kind"],
        "name": match.slots["entity"],
    }


async def _rows_stat(accessor: PostgresAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> FileStat:
    await _entity_guard(accessor, match, path.virtual)
    schema = match.slots["schema"]
    kind = match.slots["kind"]
    entity = match.slots["entity"]
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        cols = await client.fetch_columns(conn, schema, entity)
        rows = await client.estimated_row_count(conn, schema, entity)
        size = await client.table_size_bytes(conn, schema, entity)
    fp_payload = orjson.dumps({"columns": cols, "rows": rows})
    fingerprint = hashlib.sha256(fp_payload).hexdigest()
    # size stays None: table_size_bytes is the on-disk storage size, not the
    # rendered JSONL length (FileStat.size must be render-derived or None,
    # see the CLAUDE.md FUSE rules). The storage size remains in extra.
    return FileStat(
        name="rows.jsonl",
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=None,
        fingerprint=fingerprint,
        extra={
            "schema": schema,
            "kind": kind,
            "name": entity,
            "row_count": rows,
            "size_bytes": size
        },
    )


stat = make_stat(
    detect_scope,
    readdir,
    guards={
        "schema": _schema_guard,
        "kind": _schema_guard,
        "entity": _entity_guard,
        "entity_schema": _entity_guard,
        "entity_semantic": _entity_guard,
    },
    extras={
        "schema": _schema_extra,
        "kind": _kind_extra,
        "entity": _entity_extra,
        "entity_schema": _entity_extra,
        "entity_semantic": _entity_extra,
    },
    overrides={"entity_rows": _rows_stat},
)
