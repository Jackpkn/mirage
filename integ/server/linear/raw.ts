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

import type { JsonValue } from '../kit/typescript/types.ts'
import { pyKey } from './pyval.ts'

// Issue.raw and Comment.raw, read and written. A mutation field whose value
// the column can carry goes in the column and nowhere else; one it cannot goes
// here under the field's own name and the column is nulled, so exactly one of
// the two holds the answer and `key in map` decides which.
export type RawMap = Record<string, JsonValue>

export function readRaw(raw: string | null): RawMap {
  if (raw === null || raw === '') return {}
  const parsed = JSON.parse(raw) as JsonValue
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

export function writeRaw(map: RawMap): string | null {
  return Object.keys(map).length === 0 ? null : JSON.stringify(map)
}

export function isNaturalString(value: JsonValue): boolean {
  return value === null || typeof value === 'string'
}

export function isNaturalInt(value: JsonValue): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value))
}

// Stage one supplied field: the column value to write, and the overlay entry
// if the column cannot carry it.
export function stage(
  map: RawMap,
  key: string,
  value: JsonValue,
  natural: (v: JsonValue) => boolean,
): JsonValue {
  if (natural(value)) {
    delete map[key]
    return value
  }
  map[key] = value
  return null
}

export function verbatim(map: RawMap, key: string, stored: JsonValue): JsonValue {
  return key in map ? (map[key] ?? null) : stored
}

// A reference id read back through the overlay. The old fake looked one up by
// hashing it, so an overlaid list or dict raises here rather than rendering
// null the way an overlaid number does.
export function refValue(map: RawMap, key: string, stored: string | null): string | null {
  if (!(key in map)) return stored
  const value = pyKey(map[key])
  return typeof value === 'string' ? value : null
}
