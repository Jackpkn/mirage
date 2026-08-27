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

import type { JsonValue } from '../kit/typescript/index.ts'

export interface MemoryRow {
  id: string
  userId: string
  memory: string
  metadataJson: string
  createdAt: string
  updatedAt: string
  score: number
  seq: number
}

// The score is the fake's own bookkeeping and never rides on a listed memory;
// only /search adds it, which is what the API does.
export function memoryJson(row: MemoryRow): JsonValue {
  return {
    id: row.id,
    memory: row.memory,
    metadata: JSON.parse(row.metadataJson) as JsonValue,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function scoredJson(row: MemoryRow): JsonValue {
  return { ...(memoryJson(row) as Record<string, JsonValue>), score: row.score }
}

export function intOf(value: JsonValue | string | null, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

export function floatOf(value: JsonValue, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

export function asObject(value: JsonValue): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}
