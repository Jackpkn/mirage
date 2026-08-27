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

import { BodyError } from './wire.ts'

// `str(body.get("content", ""))` is what the python fake wrote into a created
// message, and str() of a non-string is python's repr, not JSON. Two facts make
// that reachable from TypeScript. First, python's json distinguishes int from
// float by the TOKEN (`5` is 5, `5.0` is 5.0) and JSON.parse erases that, so
// the parse below keeps each number's source text; V8 hands it to the reviver
// as `context.source`. Second, python's float repr is the shortest round-trip
// digits laid out by its own rules, which differ from JavaScript's at both
// notation thresholds -- python leaves fixed notation at 1e16 and below 1e-4
// where JavaScript waits for 1e21 and 1e-7, and python pads the exponent to two
// digits. Both are reproduced here rather than approximated.

class PyNumber {
  readonly source: string

  constructor(source: string) {
    this.source = source
  }
}

type PyValue = string | boolean | null | PyNumber | PyValue[] | { [key: string]: PyValue }

interface SourceContext {
  source?: string
}

type SourceReviver = (
  this: unknown,
  key: string,
  value: PyValue,
  context?: SourceContext,
) => PyValue

// TypeScript's lib types the reviver with two parameters, and a three-parameter
// function is not assignable to that, so the third argument has to be reached
// by restating the signature. The cast widens nothing: `tag` below is the only
// reviver passed here and it is typed.
const parseTagged = JSON.parse as unknown as (text: string, reviver: SourceReviver) => PyValue

const tag: SourceReviver = (_key, value, context) => {
  if (typeof value === 'number' && context?.source !== undefined)
    return new PyNumber(context.source)
  return value
}

const FLOAT_TOKEN = /[.eE]/
const SHORT_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

export function pyFloat(n: number): string {
  if (Number.isNaN(n)) return 'nan'
  if (n === Infinity) return 'inf'
  if (n === -Infinity) return '-inf'
  const sign = n < 0 || Object.is(n, -0) ? '-' : ''
  const abs = Math.abs(n)
  if (abs === 0) return `${sign}0.0`
  const parts = abs.toExponential().split('e')
  const exp = Number(parts[1])
  const digits = (parts[0] ?? '').replace('.', '')
  if (exp < -4 || exp >= 16) {
    const head = digits.length === 1 ? digits : `${digits[0] ?? ''}.${digits.slice(1)}`
    return `${sign}${head}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  if (exp >= 0) {
    const whole = digits.padEnd(exp + 1, '0').slice(0, exp + 1)
    const frac = digits.slice(exp + 1)
    return `${sign}${whole}.${frac === '' ? '0' : frac}`
  }
  return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`
}

function numberRepr(num: PyNumber): string {
  if (FLOAT_TOKEN.test(num.source)) return pyFloat(Number(num.source))
  // An int keeps its own token, so a value past 2^53 reads back exactly
  // instead of through a double. JSON writes no leading zeros and no plus, so
  // negative zero is the only token python spells differently.
  return num.source === '-0' ? '0' : num.source
}

// python's repr picks the quote: single unless the text holds one and no
// double. Non-ASCII stays verbatim, which is what python does for every
// printable code point; a non-printable one above 7 bits is the one shape this
// does not reproduce and no fixture or caller carries one.
export function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of s) {
    if (ch === quote) out += `\\${ch}`
    else if (SHORT_ESCAPES[ch] !== undefined) out += SHORT_ESCAPES[ch]
    else if (ch.charCodeAt(0) < 0x20 || ch === '\x7f') {
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
    } else out += ch
  }
  return `${quote}${out}${quote}`
}

function isPyMapping(v: PyValue): v is { [key: string]: PyValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyNumber)
}

export function pyRepr(v: PyValue): string {
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return pyStrRepr(v)
  if (v instanceof PyNumber) return numberRepr(v)
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  return `{${Object.entries(v)
    .map(([k, item]) => `${pyStrRepr(k)}: ${pyRepr(item)}`)
    .join(', ')}}`
}

export function pyStr(v: PyValue | undefined): string {
  if (v === undefined) return ''
  return typeof v === 'string' ? v : pyRepr(v)
}

// The two body fields the fake coerces, read straight off the request bytes so
// the number tokens survive. The body has already been validated as a JSON
// object by the time this runs.
export function pyField(raw: Buffer, key: string): string {
  const parsed = parseTagged(raw.toString('utf8'), tag)
  if (!isPyMapping(parsed)) throw new BodyError('request body must be a JSON object')
  return pyStr(parsed[key])
}
