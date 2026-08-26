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

import type { GwsState } from '../store/state.ts'
import type { DriveItem } from '../store/types.ts'

export interface QueryClause {
  field: string
  op: string
  value: string
}

export function unescapeQ(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) {
      i += 1
      out += value[i]
      continue
    }
    out += value[i]
  }
  return out
}

// AND-only Drive query parser covering the clauses mirage and the gws
// commands emit: 'id' in parents, name = / contains, mimeType =, trashed,
// modifiedTime >= / <.
export function parseDriveQuery(q: string): QueryClause[] {
  const clauses: QueryClause[] = []
  let depth = false
  let current = ''
  const parts: string[] = []
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i] as string
    // Drive escapes a quote inside a quoted value as \', so the splitter
    // has to step over the pair the way the clause regexes below already
    // do; toggling on it would end the value early and swallow the ` and `
    // that follows into the same clause.
    if (depth && c === '\\' && i + 1 < q.length) {
      current += c + (q[i + 1] as string)
      i += 1
      continue
    }
    if (c === "'") depth = !depth
    if (!depth && q.slice(i, i + 5) === ' and ') {
      parts.push(current)
      current = ''
      i += 4
      continue
    }
    current += c
  }
  if (current.trim() !== '') parts.push(current)
  for (const raw of parts) {
    const part = raw.trim()
    let m = /^'((?:[^'\\]|\\.)*)'\s+in\s+parents$/.exec(part)
    if (m !== null) {
      clauses.push({ field: 'parents', op: 'in', value: unescapeQ(m[1] as string) })
      continue
    }
    m = /^(\w+)\s*(=|!=|>=|<=|>|<|contains)\s*'((?:[^'\\]|\\.)*)'$/.exec(part)
    if (m !== null) {
      clauses.push({ field: m[1] as string, op: m[2] as string, value: unescapeQ(m[3] as string) })
      continue
    }
    m = /^(\w+)\s*=\s*(true|false)$/.exec(part)
    if (m !== null) {
      clauses.push({ field: m[1] as string, op: '=', value: m[2] as string })
      continue
    }
    throw new Error(`unsupported query clause: ${part}`)
  }
  return clauses
}

// Everything the live index searches for `fullText`: the display name, a
// Doc's flat text, a Sheet's cell values, and an uploaded file's bytes.
// Case-insensitive, the way the real search index answers.
export function fullTextOf(st: GwsState, item: DriveItem): string {
  const parts: string[] = [item.name]
  const doc = st.docs.get(item.id)
  if (doc !== undefined) parts.push(doc.text)
  const sheet = st.sheets.get(item.id)
  if (sheet !== undefined) {
    for (const tab of sheet.tabs) parts.push([...tab.cells.values()].join(' '))
  }
  if (item.content.length > 0) parts.push(item.content.toString('utf8'))
  return parts.join('\n')
}

export function matchClause(st: GwsState, item: DriveItem, clause: QueryClause): boolean {
  switch (clause.field) {
    case 'parents':
      return item.parents.includes(clause.value)
    case 'name':
      if (clause.op === 'contains') return item.name.includes(clause.value)
      if (clause.op === '!=') return item.name !== clause.value
      return item.name === clause.value
    case 'mimeType':
      if (clause.op === 'contains') return item.mimeType.includes(clause.value)
      if (clause.op === '!=') return item.mimeType !== clause.value
      return item.mimeType === clause.value
    case 'fullText':
      // The live API defines only `contains` for fullText; any other
      // operator is an invalid query, reported as the 400 the caller
      // catches below.
      if (clause.op !== 'contains') {
        throw new Error(`unsupported operator for fullText: ${clause.op}`)
      }
      return fullTextOf(st, item).toLowerCase().includes(clause.value.toLowerCase())
    case 'trashed':
      return item.trashed === (clause.value === 'true')
    case 'modifiedTime': {
      if (clause.op === '>=') return item.modifiedTime >= clause.value
      if (clause.op === '<') return item.modifiedTime < clause.value
      if (clause.op === '>') return item.modifiedTime > clause.value
      if (clause.op === '<=') return item.modifiedTime <= clause.value
      return item.modifiedTime === clause.value
    }
    default:
      throw new Error(`unsupported query field: ${clause.field}`)
  }
}
