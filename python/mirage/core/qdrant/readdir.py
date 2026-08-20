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

import logging
from typing import Any

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.probe import ReaddirFn
from mirage.core.hierarchy.readdir import Lister, make_readdir
from mirage.core.hierarchy.scope import ROOT, ScopeMatch
from mirage.core.qdrant.query import (distinct_values, list_tables,
                                      rows_matching, table_exists)
from mirage.core.qdrant.render import blob_bytes, render_json, render_text
from mirage.core.qdrant.scope import detect_for, filters_of, table_of
from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import JsonValue, PathSpec

logger = logging.getLogger(__name__)

GROUP_TYPE = "qdrant/group"


def _dir_entry(name: str) -> IndexEntry:
    return IndexEntry(id=name,
                      name=name,
                      resource_type=GROUP_TYPE,
                      vfs_name=name)


def _blob_size(value: JsonValue) -> int | None:
    # A payload whose blob column holds something undecodable must not take
    # the whole listing down with it: leave the size unknown and let read()
    # raise the same error it always did.
    try:
        return len(blob_bytes(value))
    except ValueError as exc:
        logger.debug("qdrant: unsizeable blob value (%s); size stays unknown",
                     exc)
        return None


def _row_entries(rows: list[dict[str, Any]],
                 config: QdrantConfig) -> list[tuple[str, IndexEntry]]:
    # The scroll already carries every payload, so each file's exact
    # rendered size is free here; stat serves it from the index instead of
    # refetching one row per file.
    entries: list[tuple[str, IndexEntry]] = []
    for row in rows:
        rid = str(row[config.id_field])
        entries.append((f"{rid}.json",
                        IndexEntry(
                            id=rid,
                            name=f"{rid}.json",
                            resource_type="qdrant/row_json",
                            vfs_name=f"{rid}.json",
                            size=len(render_json(row, config)),
                        )))
        if config.text_field and row.get(config.text_field) is not None:
            entries.append((f"{rid}.txt",
                            IndexEntry(
                                id=rid,
                                name=f"{rid}.txt",
                                resource_type="qdrant/row_text",
                                vfs_name=f"{rid}.txt",
                                size=len(render_text(row, config)),
                            )))
        if config.blob_field and row.get(config.blob_field) is not None:
            blob_name = f"{rid}.{config.blob_ext}"
            entries.append((blob_name,
                            IndexEntry(
                                id=rid,
                                name=blob_name,
                                resource_type="qdrant/row_blob",
                                vfs_name=blob_name,
                                size=_blob_size(row[config.blob_field]),
                            )))
    return entries


async def _children(
        accessor: QdrantAccessor, table: str,
        filters: dict[str, str]) -> list[tuple[str, IndexEntry]] | None:
    config = accessor.config
    if not await table_exists(accessor, table):
        return None
    depth = len(filters)
    if depth < len(config.group_by):
        names = await distinct_values(accessor, table, config.group_by[depth],
                                      filters, config.max_rows)
        return [(name, _dir_entry(name)) for name in names]
    rows = await rows_matching(accessor, table, filters, config.max_rows)
    return _row_entries(rows, config)


async def _list_root(accessor: QdrantAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    config = accessor.config
    if not config.collection:
        return [(name, _dir_entry(name))
                for name in await list_tables(accessor)]
    return await _children(accessor, config.collection, {})


async def _list_group(
        accessor: QdrantAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    config = accessor.config
    return await _children(accessor, table_of(config, match),
                           filters_of(config, match))


LISTERS: dict[str, Lister[QdrantAccessor]] = {
    ROOT: _list_root,
    "group": _list_group,
}


def _build(accessor: QdrantAccessor) -> ReaddirFn[QdrantAccessor]:
    return make_readdir(detect_for(accessor), listers=LISTERS)


readdir_for = per_accessor(_build)


async def readdir(
    accessor: QdrantAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    return await readdir_for(accessor)(accessor, path, index)
