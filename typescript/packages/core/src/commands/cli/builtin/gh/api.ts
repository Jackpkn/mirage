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

import { FlagView } from '../../../spec/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { expand } from '../../../../core/github/placeholder.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { jqEval } from '../../../../core/jq/index.ts'
import { ghTransport, jsonOut, textOut } from './accessor.ts'

/**
 * `-f key=value` is always a string; `-F key=value` reads `true`, `false`,
 * `null` and integers as their JSON types, which is gh's own split between
 * `--raw-field` and `--field`.
 */
function typed(value: string): string | number | boolean | null {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function split(pair: string): [string, string] {
  const at = pair.indexOf('=')
  if (at < 0) throw new Error(`expected "key=value", got "${pair}"`)
  return [pair.slice(0, at), pair.slice(at + 1)]
}

/**
 * One `--jq` output the way gh renders it, probed against 2.85: a string
 * prints raw, null prints as an empty line (where jq's own `-r` would
 * print the word), and every other value prints as compact JSON. Each
 * output ends its own line.
 */
function jqLine(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export async function api(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const endpoint = inv.texts[0] ?? ''
  if (endpoint === '') throw new Error('an API endpoint is required')
  const fields: Record<string, string | number | boolean | null> = {}
  for (const pair of fl.asList('raw_field')) {
    const [key, value] = split(pair)
    fields[key] = value
  }
  const config = inv.config as GhConfig
  for (const pair of fl.asList('field')) {
    const [key, value] = split(pair)
    // gh expands a placeholder in a `-F` value but not in a `-f` one, which
    // its own --help spells out and a live 2.85 confirms.
    fields[key] = typed(expand(value, config))
  }
  // gh sends a body-bearing call as POST unless --method says otherwise,
  // and a bare one as GET.
  const method = fl.asStr('method') ?? (Object.keys(fields).length > 0 ? 'POST' : 'GET')
  const expanded = expand(endpoint, config)
  const path = expanded.startsWith('/') ? expanded : `/${expanded}`
  const upper = method.toUpperCase()
  // `api` is one leaf for both halves of the API, so whether it wrote is on
  // the line rather than in the spec: a GET must not expire every github
  // mount the install serves.
  const mutated = !READ_METHODS.has(upper)
  const empty = Object.keys(fields).length === 0
  // A GET carries its fields in the query string, everything else in a JSON
  // body; a call with no fields sends neither, so a bare DELETE has no body.
  let reply: unknown
  if (upper === 'GET') {
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(fields)) params[key] = String(value)
    reply = await ghTransport(inv.config).request(upper, path, undefined, params)
  } else {
    reply = await ghTransport(inv.config).request(upper, path, empty ? undefined : fields)
  }
  // `--jq` filters the response client-side, exactly as real gh does; a
  // failing request never reaches it. Deliberate divergence: a bad or
  // failing program is reported in mirage's jq engine's words, not
  // gojq's, with the same exit code.
  const program = fl.asStr('jq')
  if (program !== undefined && program !== '') {
    const values = await jqEval(reply, program)
    return textOut(values.map((v) => `${jqLine(v)}\n`).join(''), mutated)
  }
  return jsonOut(reply, mutated)
}
