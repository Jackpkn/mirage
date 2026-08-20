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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'
import type { QdrantRow } from './client.ts'
import { PathSpec } from '../../types.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import type { ReaddirFn } from '../hierarchy/probe.ts'
import { makeReaddir, type Lister } from '../hierarchy/readdir.ts'
import { ROOT, type ScopeMatch } from '../hierarchy/scope.ts'
import { blobBytes, renderJson, renderText } from './render.ts'
import { detectFor, filtersOf, tableOf } from './scope.ts'

const GROUP_TYPE = 'qdrant/group'

function dirEntry(name: string): IndexEntry {
  return new IndexEntry({ id: name, name, resourceType: GROUP_TYPE, vfsName: name })
}

function blobSize(value: unknown): number | null {
  // A payload whose blob column holds something undecodable must not take
  // the whole listing down with it: leave the size unknown and let read()
  // throw the same error it always did.
  try {
    return blobBytes(value).byteLength
  } catch {
    return null
  }
}

function rowEntries(rows: QdrantRow[], config: QdrantConfigResolved): [string, IndexEntry][] {
  // The scroll already carries every payload, so each file's exact rendered
  // size is free here; stat serves it from the index instead of refetching
  // one row per file.
  const entries: [string, IndexEntry][] = []
  for (const row of rows) {
    const id = String(row[config.idField])
    entries.push([
      `${id}.json`,
      new IndexEntry({
        id,
        name: `${id}.json`,
        resourceType: 'qdrant/row_json',
        vfsName: `${id}.json`,
        size: renderJson(row, config).byteLength,
      }),
    ])
    if (
      config.textField !== null &&
      row[config.textField] !== null &&
      row[config.textField] !== undefined
    ) {
      entries.push([
        `${id}.txt`,
        new IndexEntry({
          id,
          name: `${id}.txt`,
          resourceType: 'qdrant/row_text',
          vfsName: `${id}.txt`,
          size: renderText(row, config).byteLength,
        }),
      ])
    }
    if (
      config.blobField !== null &&
      row[config.blobField] !== null &&
      row[config.blobField] !== undefined
    ) {
      const blobName = `${id}.${config.blobExt}`
      entries.push([
        blobName,
        new IndexEntry({
          id,
          name: blobName,
          resourceType: 'qdrant/row_blob',
          vfsName: blobName,
          size: blobSize(row[config.blobField]),
        }),
      ])
    }
  }
  return entries
}

async function children(
  accessor: QdrantAccessor,
  table: string,
  filters: Record<string, string>,
): Promise<[string, IndexEntry][] | null> {
  const config = accessor.config
  if (!(await accessor.tableExists(table))) return null
  const depth = Object.keys(filters).length
  if (depth < config.groupBy.length) {
    const names = await accessor.distinct(
      table,
      config.groupBy[depth] ?? '',
      filters,
      config.maxRows,
    )
    return names.map((name): [string, IndexEntry] => [name, dirEntry(name)])
  }
  const rows = await accessor.rowsMatching(table, filters, [config.idField], config.maxRows)
  return rowEntries(rows, config)
}

async function listRoot(
  accessor: QdrantAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const config = accessor.config
  if (config.collection === null) {
    const tables = await accessor.listTables()
    return tables.map((name): [string, IndexEntry] => [name, dirEntry(name)])
  }
  return children(accessor, config.collection, {})
}

async function listGroup(
  accessor: QdrantAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const config = accessor.config
  return children(accessor, tableOf(config, match), filtersOf(config, match))
}

const LISTERS: Record<string, Lister<QdrantAccessor>> = {
  [ROOT]: listRoot,
  group: listGroup,
}

function buildReaddir(accessor: QdrantAccessor): ReaddirFn<QdrantAccessor> {
  return makeReaddir(detectFor(accessor), { listers: LISTERS })
}

export const readdirFor = perAccessor(buildReaddir)

export async function readdir(
  accessor: QdrantAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return readdirFor(accessor)(accessor, spec, index)
}
