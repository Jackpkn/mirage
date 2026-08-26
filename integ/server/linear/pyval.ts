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

// The live fake put every variable straight into a Python expression and never
// checked its type, so Python's own rules ARE the fake's contract for anything
// the client does not send. A raising expression answered 500 and a coercing
// one answered 200 with a coerced value, and both are observable. These are
// the six expressions the old file used, spelled once here rather than guessed
// at by each call site.
export class PyError extends Error {}

export function pyTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false
  if (value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

// `d[k]`, `k in d` and `d.get(k)` all hash the key first, so a list or a dict
// where an id belongs raises before the lookup misses.
export function pyKey(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) throw new PyError("unhashable type: 'list'")
  if (typeof value === 'object' && value !== null) throw new PyError("unhashable type: 'dict'")
  return value
}

// `x.get(...)` on a non-dict.
function pyTypeName(value: JsonValue | undefined): string {
  return value === null || value === undefined ? 'NoneType' : typeof value
}

export function pyDict(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PyError(`'${pyTypeName(value)}' object has no attribute 'get'`)
  }
  return value
}

// `variables.get(k) or {}`: a falsy value becomes the empty dict, a truthy
// non-dict reaches the next `.get` and raises there, which is the same request.
export function pyDictOr(value: JsonValue | undefined): Record<string, JsonValue> {
  return pyTruthy(value) ? pyDict(value) : {}
}

// `(x or "").lower()` and `body.get("query") or ""`.
export function pyStrOr(value: JsonValue | undefined): string {
  if (!pyTruthy(value)) return ''
  if (typeof value === 'string') return value
  throw new PyError(`'${typeof value}' object has no attribute 'lower'`)
}

// `list(x)`: a string spreads into characters, a dict into its keys, and
// anything without an iterator raises.
export function pyList(value: JsonValue | undefined): JsonValue[] {
  if (typeof value === 'string') return [...value]
  if (Array.isArray(value)) return [...value]
  if (typeof value === 'object' && value !== null) return Object.keys(value)
  throw new PyError(`'${pyTypeName(value)}' object is not iterable`)
}

// `int(x)`: a float truncates toward zero, a bool is 0 or 1, and a string is
// parsed strictly, so "2.5" raises where 2.5 truncates to 2.
export function pyInt(value: JsonValue | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string') {
    const body = value.trim()
    if (!/^[+-]?[0-9]+$/.test(body)) {
      throw new PyError(`invalid literal for int() with base 10: ${JSON.stringify(value)}`)
    }
    return Number(body)
  }
  throw new PyError('int() argument must be a string or a number')
}

// `" ".join([...])`: every part must already be a str.
export function pyJoinPart(value: JsonValue | undefined): string {
  if (!pyTruthy(value)) return ''
  if (typeof value === 'string') return value
  throw new PyError(`sequence item: expected str instance, ${typeof value} found`)
}

// `len(nodes) >= limit`, where limit is whatever `variables.get("first") or 50`
// produced. int and bool compare; nothing else does.
export function pyGe(count: number, limit: JsonValue): boolean {
  if (typeof limit === 'number') return count >= limit
  if (typeof limit === 'boolean') return count >= (limit ? 1 : 0)
  throw new PyError(`'>=' not supported between instances of 'int' and '${typeof limit}'`)
}
