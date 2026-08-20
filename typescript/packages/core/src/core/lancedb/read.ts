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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { LanceRow } from './_driver.ts'
import { PathSpec } from '../../types.ts'
import { decodeBase64 } from '../../utils/base64.ts'
import { enoent } from '../../utils/errors.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { makeRead, type Reader } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { renderCard } from './render.ts'
import { detectFor, tableOf } from './scope.ts'

async function rowOf(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<LanceRow> {
  const config = accessor.config
  const row = await accessor.driver.rowRecord(
    tableOf(config, match),
    config.idColumn,
    match.slots.row_id ?? '',
  )
  if (row === null) throw enoent(virtual)
  return row
}

function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return decodeBase64(value)
  throw new Error('blob column is not bytes or base64 string')
}

async function readCard(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const row = await rowOf(accessor, match, path.virtual)
  return renderCard(row, accessor.config)
}

async function readBlob(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const config = accessor.config
  if (config.blobColumn === null) throw enoent(path.virtual)
  const row = await rowOf(accessor, match, path.virtual)
  return blobBytes(row[config.blobColumn])
}

const READERS: Record<string, Reader<LanceDBAccessor>> = {
  row_card: readCard,
  row_blob: readBlob,
}

function buildRead(accessor: LanceDBAccessor) {
  return makeRead(detectFor(accessor), READERS)
}

const readFor = perAccessor(buildRead)

export async function read(
  accessor: LanceDBAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return readFor(accessor)(accessor, spec, index)
}
