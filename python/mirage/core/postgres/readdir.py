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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.postgres import client
from mirage.core.postgres.scope import ENTITY_FILES, KIND_DIRS, detect_scope


async def _list_root(accessor: PostgresAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await client.list_schemas(conn, accessor.config.schemas)
    entries: list[tuple[str, IndexEntry]] = [(
        "database.json",
        IndexEntry(id="database.json",
                   name="database.json",
                   resource_type="postgres/database_json",
                   vfs_name="database.json"),
    )]
    for s in schemas:
        entries.append((s,
                        IndexEntry(id=s,
                                   name=s,
                                   resource_type="postgres/schema",
                                   vfs_name=s)))
    return entries


async def _list_schema(accessor: PostgresAccessor,
                       match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    # tables/ and views/ exist by construction under every schema, the
    # same way the entity files below do under every entity.
    return [(name,
             IndexEntry(id=name,
                        name=name,
                        resource_type="postgres/kind",
                        vfs_name=name)) for name in KIND_DIRS]


async def _list_entities(accessor: PostgresAccessor,
                         match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
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
    return [(n,
             IndexEntry(id=n,
                        name=n,
                        resource_type=f"postgres/{kind[:-1]}",
                        vfs_name=n)) for n in names]


async def _list_entity_files(
        accessor: PostgresAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    return [(name,
             IndexEntry(id=name,
                        name=name,
                        resource_type="postgres/entity_file",
                        vfs_name=name)) for name in ENTITY_FILES]


readdir = make_readdir(
    detect_scope,
    listers={
        "root": _list_root,
        "schema": _list_schema,
        "kind": _list_entities,
        "entity": _list_entity_files,
    },
)
