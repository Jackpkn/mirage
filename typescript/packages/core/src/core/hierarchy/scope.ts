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

import { PathSpec, type FileType } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { RAW, type Codec } from './codec.ts'

export const ROOT = 'root'
export const INVALID = 'invalid'

/**
 * One dynamic segment of a scope: the key the decoded value is stored under,
 * and how the segment encodes it. `idKey` is set for `<label>__<id>`
 * composite segments: the decoded payload splits on its LAST `__` (so a
 * three-part `KEY__name__id` keeps `KEY__name` as the label), the label
 * stored under `name` and the id under `idKey`. A payload with no `__` or an
 * empty half does not match the scope.
 */
export class Slot {
  readonly name: string
  readonly codec: Codec
  readonly idKey: string | null

  constructor(name: string, codec: Codec = RAW, idKey: string | null = null) {
    this.name = name
    this.codec = codec
    this.idKey = idKey
  }
}

/**
 * One addressable position in a fixed API hierarchy.
 *
 * `kind` is the position's name; listers, probes and readers key on it.
 * `segments` is the path shape, literals and slots. `leaf` marks a file
 * rather than a directory, `filetype` its rendered type. `probed` is whether
 * stat must prove existence (parent listing by default); false for positions
 * that exist by construction, like the top-level directories.
 */
export class Scope {
  readonly kind: string
  readonly segments: readonly (string | Slot)[]
  readonly leaf: boolean
  readonly filetype: FileType | null
  readonly probed: boolean

  constructor(init: {
    kind: string
    segments: readonly (string | Slot)[]
    leaf?: boolean
    filetype?: FileType
    probed?: boolean
  }) {
    this.kind = init.kind
    this.segments = init.segments
    this.leaf = init.leaf ?? false
    this.filetype = init.filetype ?? null
    this.probed = init.probed ?? true
  }
}

/**
 * Where in the hierarchy a path landed.
 *
 * `kind` is the matched scope's kind, or `root`/`invalid`. `slots` holds
 * the decoded dynamic segments by name. `resourcePath` is the raw path that
 * was classified. `scope` is the matched scope; null for root and invalid.
 */
export interface ScopeMatch {
  readonly kind: string
  readonly resourcePath: string
  readonly slots: Record<string, string>
  readonly scope: Scope | null
}

export type DetectFn = (path: PathSpec | string) => ScopeMatch

/** Match path segments against the table, first declared scope wins. */
export function matchScope(
  scopes: readonly Scope[],
  parts: readonly string[],
): [Scope, Record<string, string>] | null {
  for (const scope of scopes) {
    if (scope.segments.length !== parts.length) continue
    const slots: Record<string, string> = {}
    let matched = true
    for (const [i, segment] of scope.segments.entries()) {
      const part = parts[i] ?? ''
      if (typeof segment === 'string') {
        if (part !== segment) {
          matched = false
          break
        }
        continue
      }
      const decoded = segment.codec.decode(part)
      if (decoded === null) {
        matched = false
        break
      }
      if (segment.idKey !== null) {
        const cut = decoded.lastIndexOf('__')
        const label = cut > 0 ? decoded.slice(0, cut) : ''
        const ident = cut >= 0 ? decoded.slice(cut + 2) : ''
        if (label === '' || ident === '') {
          matched = false
          break
        }
        slots[segment.name] = label
        slots[segment.idKey] = ident
        continue
      }
      slots[segment.name] = decoded
    }
    if (matched) return [scope, slots]
  }
  return null
}

/**
 * Build a path classifier from a scope table.
 *
 * The classifier is the single description of the backend's tree: readdir,
 * stat, read, and any search push-down all dispatch on its result, so the
 * file surface and the command surface cannot disagree about what a path
 * means. Hidden segments classify as invalid, which every consumer turns
 * into ENOENT. Scopes are matched in declaration order.
 *
 * Postgres's table, classified level by level:
 *
 *     path                             kind         slots
 *     /                                root         {}
 *     /public                          schema       {schema}
 *     /public/tables                   kind         {schema, kind}
 *     /public/tables/books             entity       {schema, kind, entity}
 *     /public/tables/books/rows.jsonl  entity_rows  {schema, kind, entity}
 *
 * `kind` names the level a path landed on; the slots identify the branch
 * taken at each dynamic level above it. Literal levels (`rows.jsonl`)
 * contribute no slot, and one dynamic level can contribute two (`idKey`).
 */
export function makeDetectScope(scopes: readonly Scope[]): DetectFn {
  return function detectScope(path: PathSpec | string): ScopeMatch {
    const raw = path instanceof PathSpec ? path.mountPath : path
    const key = stripSlash(raw)
    if (key === '') return { kind: ROOT, resourcePath: raw, slots: {}, scope: null }
    const parts = key.split('/')
    if (parts.some((p) => p.startsWith('.'))) {
      return { kind: INVALID, resourcePath: raw, slots: {}, scope: null }
    }
    const matched = matchScope(scopes, parts)
    if (matched === null) return { kind: INVALID, resourcePath: raw, slots: {}, scope: null }
    const [scope, slots] = matched
    return { kind: scope.kind, resourcePath: raw, slots, scope }
  }
}
