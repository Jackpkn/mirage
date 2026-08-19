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

from typing import Any

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.mongodb.client import count_documents, get_indexes, is_view
from mirage.core.mongodb.readdir import database_guard, entity_guard, readdir
from mirage.core.mongodb.scope import detect_scope, entity_kind
from mirage.core.mongodb.types import EntityKind
from mirage.types import FileStat, FileType, PathSpec


def _database_extra(match: ScopeMatch) -> dict[str, str]:
    return {"database": match.slots["database"]}


def _kind_dir_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "database": match.slots["database"],
        "kind": entity_kind(match),
    }


def _entity_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "database": match.slots["database"],
        "kind": entity_kind(match),
        "name": match.slots["name"],
    }


async def _entity_stat(accessor: MongoDBAccessor, match: ScopeMatch,
                       path: PathSpec, index: IndexCacheStore) -> FileStat:
    await entity_guard(accessor, match, path.virtual)
    database = match.slots["database"]
    name = match.slots["name"]
    doc_count = await count_documents(accessor.client, database, name)
    return FileStat(
        name=name,
        type=FileType.DIRECTORY,
        extra={
            "database": database,
            "kind": entity_kind(match),
            "name": name,
            "document_count": doc_count,
        },
    )


async def _documents_stat(accessor: MongoDBAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> FileStat:
    await entity_guard(accessor, match, path.virtual)
    database = match.slots["database"]
    name = match.slots["name"]
    view = (entity_kind(match) == EntityKind.VIEW
            or await is_view(accessor.client, database, name))
    doc_count = await count_documents(accessor.client, database, name)
    if view:
        index_info: list[dict[str, Any]] = []
    else:
        indexes = await get_indexes(accessor.client, database, name)
        index_info = [{
            "name": idx.get("name"),
            "keys": dict(idx.get("key", {}))
        } for idx in indexes]
    return FileStat(
        name="documents.jsonl",
        type=FileType.TEXT,
        extra={
            "database": database,
            "name": name,
            "kind": EntityKind.VIEW if view else EntityKind.COLLECTION,
            "document_count": doc_count,
            "indexes": index_info,
        },
    )


stat = make_stat(
    detect_scope,
    readdir,
    guards={
        "database": database_guard,
        "kind_dir": database_guard,
        "database_json": database_guard,
        "schema_json": entity_guard,
    },
    extras={
        "database": _database_extra,
        "kind_dir": _kind_dir_extra,
        "database_json": _database_extra,
        "schema_json": _entity_extra,
    },
    overrides={
        "entity": _entity_stat,
        "documents": _documents_stat,
    },
)
