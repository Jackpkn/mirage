// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { LanceDBConfigResolved } from '../../resource/lancedb/config.ts'
import type { LanceRow } from './_driver.ts'
import { PathSpec } from '../../types.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import type { ReaddirFn } from '../hierarchy/probe.ts'
import { makeReaddir, type Lister } from '../hierarchy/readdir.ts'
import { ROOT, type ScopeMatch } from '../hierarchy/scope.ts'
import { renderCard } from './render.ts'
import { detectFor, filtersOf, tableOf } from './scope.ts'

const GROUP_TYPE = 'lancedb/group'

function dirEntry(name: string): IndexEntry {
  return new IndexEntry({ id: name, name, resourceType: GROUP_TYPE, vfsName: name })
}

function rowEntries(rows: LanceRow[], config: LanceDBConfigResolved): [string, IndexEntry][] {
  // The widened select carries every rendered column, so each card's exact
  // size is free here; blob values are deliberately not fetched at listing
  // time, so blob entries stay size-unknown and stat renders them itself.
  const entries: [string, IndexEntry][] = []
  for (const row of rows) {
    const id = String(row[config.idColumn])
    entries.push([
      `${id}.md`,
      new IndexEntry({
        id,
        name: `${id}.md`,
        resourceType: 'lancedb/row_card',
        vfsName: `${id}.md`,
        size: renderCard(row, config).byteLength,
      }),
    ])
    if (config.blobColumn !== null) {
      const blobName = `${id}.${config.blobExt}`
      entries.push([
        blobName,
        new IndexEntry({
          id,
          name: blobName,
          resourceType: 'lancedb/row_blob',
          vfsName: blobName,
        }),
      ])
    }
  }
  return entries
}

async function children(
  accessor: LanceDBAccessor,
  table: string,
  filters: Record<string, string>,
): Promise<[string, IndexEntry][] | null> {
  const config = accessor.config
  const tables = await accessor.driver.listTables()
  if (!tables.includes(table)) return null
  const depth = Object.keys(filters).length
  if (depth < config.groupBy.length) {
    const names = await accessor.driver.distinct(
      table,
      config.groupBy[depth] ?? '',
      filters,
      config.maxRows,
    )
    return names.map((name): [string, IndexEntry] => [name, dirEntry(name)])
  }
  // Select every column except the vector and blob ones (schema order, so
  // the projected rows render byte-identically to the full rows read()
  // fetches). Still one data query; the schema lookup is local metadata on
  // the already-opened table.
  const columns = (await accessor.driver.tableColumns(table)).filter(
    (c) => c !== config.vectorColumn && c !== config.blobColumn,
  )
  const rows = await accessor.driver.rowsMatching(table, filters, columns, config.maxRows)
  return rowEntries(rows, config)
}

async function listRoot(
  accessor: LanceDBAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const config = accessor.config
  if (config.table === null) {
    const tables = await accessor.driver.listTables()
    return tables.map((name): [string, IndexEntry] => [name, dirEntry(name)])
  }
  return children(accessor, config.table, {})
}

async function listGroup(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const config = accessor.config
  return children(accessor, tableOf(config, match), filtersOf(config, match))
}

const LISTERS: Record<string, Lister<LanceDBAccessor>> = {
  [ROOT]: listRoot,
  group: listGroup,
}

function buildReaddir(accessor: LanceDBAccessor): ReaddirFn<LanceDBAccessor> {
  return makeReaddir(detectFor(accessor), { listers: LISTERS })
}

export const readdirFor = perAccessor(buildReaddir)

export async function readdir(
  accessor: LanceDBAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return readdirFor(accessor)(accessor, spec, index)
}
