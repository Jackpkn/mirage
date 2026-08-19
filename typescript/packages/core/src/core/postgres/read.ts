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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { encodeBase64 } from '../../utils/base64.ts'
import { jsonBytes } from '../render/json.ts'
import type { PostgresAccessor } from '../../accessor/postgres.ts'
import { makeRead, type Reader, type ReadWindow, type WindowedReader } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { estimateSize, fetchRows } from './client.ts'
import { buildDatabaseJson, buildEntitySchemaJson } from './_schema_json.ts'
import { buildEntitySemanticJson } from './semantic.ts'
import { detectScope } from './scope.ts'

export interface ReadOptions {
  limit?: number | null
  offset?: number | null
}

export async function* readStream(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
  options: ReadOptions = {},
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index, options)
}

function entityKind(match: ScopeMatch): 'table' | 'view' {
  return (match.slots.kind ?? '') === 'tables' ? 'table' : 'view'
}

const readDatabaseJson: Reader<PostgresAccessor> = async (accessor) =>
  jsonBytes(await buildDatabaseJson(accessor))

const readEntitySchema: Reader<PostgresAccessor> = async (accessor, match) =>
  jsonBytes(
    await buildEntitySchemaJson(
      accessor,
      match.slots.schema ?? '',
      match.slots.entity ?? '',
      entityKind(match),
    ),
  )

const readEntitySemantic: Reader<PostgresAccessor> = async (accessor, match) =>
  jsonBytes(
    await buildEntitySemanticJson(
      accessor,
      match.slots.schema ?? '',
      match.slots.entity ?? '',
      entityKind(match),
    ),
  )

const readEntityRows: WindowedReader<PostgresAccessor> = (accessor, match, _path, _index, window) =>
  readRows(
    accessor,
    match.slots.schema ?? '',
    match.slots.kind ?? '',
    match.slots.entity ?? '',
    window,
  )

const kitRead = makeRead<PostgresAccessor>(
  detectScope,
  {
    database_json: readDatabaseJson,
    entity_schema: readEntitySchema,
    entity_semantic: readEntitySemantic,
  },
  { entity_rows: readEntityRows },
)

export async function read(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
  options: ReadOptions = {},
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return kitRead(accessor, spec, index, options)
}

async function readRows(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  entity: string,
  options: ReadWindow,
): Promise<Uint8Array> {
  const cfg = accessor.config
  const limit = options.limit ?? null
  const offset = options.offset ?? null
  let effectiveLimit: number
  let effectiveOffset: number

  if (limit === null && offset === null) {
    const [rows, width] = await estimateSize(accessor, schema, entity)
    const widthEffective = Math.max(width, 1)
    if (rows > cfg.maxReadRows || rows * widthEffective > cfg.maxReadBytes) {
      throw new Error(
        `${schema}/${kind}/${entity}/rows.jsonl too large to read entirely: ` +
          `~${String(rows)} rows / ~${String(rows * widthEffective)} bytes ` +
          `(thresholds: ${String(cfg.maxReadRows)} rows / ${String(cfg.maxReadBytes)} bytes); ` +
          `use head, tail, wc, grep, or pass limit/offset`,
      )
    }
    effectiveLimit = rows !== 0 ? rows : cfg.defaultRowLimit
    effectiveOffset = 0
  } else {
    effectiveLimit = limit ?? cfg.defaultRowLimit
    effectiveOffset = offset ?? 0
  }

  const data = await fetchRows(accessor, schema, entity, {
    limit: effectiveLimit,
    offset: effectiveOffset,
  })
  if (data.length === 0) return new Uint8Array()
  const lines = data.map((r) => JSON.stringify(r, jsonReplacer))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return encodeBase64(value)
  return value
}
