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

import { ECHO_OPTION } from '../../../commands/spec/shell.ts'
import { IOResult } from '../../../io/types.ts'
import { byteChar, encodeText } from '../../../shell/bytes.ts'
import { PolicyDenied } from '../../../policy/errors.ts'
import { ArithError } from '../../../shell/errors.ts'
import type { Session } from '../../session/session.ts'
import type { SessionView } from '../../../ops/types.ts'
import { assignElement } from '../../session/elements.ts'
import { ExecutionNode } from '../../types.ts'
import { runPrintf } from './printf_format.ts'
import type { Result } from './shared.ts'

// A subscript must be non-empty: bash rejects `a[]` as an invalid
// identifier, while `a[ ]` is a valid arithmetic 0.
export const PRINTF_TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.+)\])?$/

const ECHO_SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '\\': '\\',
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
})

const HEX_CHARS = new Set('0123456789abcdefABCDEF')
const OCT_CHARS = new Set('01234567')

/**
 * Process C-style escape sequences for `echo -e`.
 *
 * Single-pass to handle `\\` correctly (`\\b` → a literal `\b`). Supports
 * `\\ \n \t \r \a \b \f \v`, `\xHH` (hex), `\0NNN` (octal) and `\c` (stop
 * output); an unknown escape like `\z` passes through as `\z`. `tr` has
 * its own reader (`commands/builtin/utils/escapes.ts`) because only the
 * shell writes bytes: `\xHH` here names a byte, not a code point.
 *
 * Exported for its test only, mirroring how Python's `_interpret_escapes`
 * is re-exported from `builtins/__init__.py`.
 */
export function interpretEchoEscapes(text: string): string {
  const out: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    if (text.charAt(i) !== '\\' || i + 1 >= n) {
      out.push(text.charAt(i))
      i += 1
      continue
    }
    const ch = text.charAt(i + 1)
    const simple = ECHO_SIMPLE_ESCAPES[ch]
    if (simple !== undefined) {
      out.push(simple)
      i += 2
    } else if (ch === 'c') {
      break
    } else if (ch === 'x') {
      let digits = ''
      let j = i + 2
      while (j < n && digits.length < 2 && HEX_CHARS.has(text.charAt(j))) {
        digits += text.charAt(j)
        j += 1
      }
      if (digits !== '') {
        out.push(byteChar(parseInt(digits, 16)))
        i = j
      } else {
        out.push('\\x')
        i += 2
      }
    } else if (ch === '0') {
      let digits = ''
      let j = i + 2
      while (j < n && digits.length < 3 && OCT_CHARS.has(text.charAt(j))) {
        digits += text.charAt(j)
        j += 1
      }
      out.push(digits !== '' ? byteChar(parseInt(digits, 8)) : '\0')
      i = j
    } else {
      out.push('\\')
      out.push(ch)
      i += 2
    }
  }
  return out.join('')
}

/**
 * Print arguments, honoring GNU echo's option rules.
 *
 * GNU echo is not getopt: options are LEADING words matching `-[neE]+`
 * only. The first word that does not match (including `-x` or a
 * repeated `hi -n`) ends option parsing and prints literally. Within
 * clusters the last of -e/-E wins; -n sticks.
 */
export function handleEcho(args: string[]): Result {
  let noNewline = false
  let escapes = false
  let idx = 0
  for (const word of args) {
    if (!ECHO_OPTION.test(word)) break
    for (const ch of word.slice(1)) {
      if (ch === 'n') noNewline = true
      else if (ch === 'e') escapes = true
      else escapes = false
    }
    idx += 1
  }
  let text = args.slice(idx).join(' ')
  if (escapes) text = interpretEchoEscapes(text)
  if (!noNewline) text += '\n'
  const out = encodeText(text)
  return [out, new IOResult(), new ExecutionNode({ command: 'echo', exitCode: 0 })]
}

/**
 * Assign `value` to a `printf -v` target (scalar or `name[idx]`).
 *
 * A delegation to the one element writer: a bare name assigns element 0
 * when the name already holds an array (indexed or associative),
 * nothing mutates unless the whole assignment succeeds, and the landing
 * write goes through the door as the whole variable, so a `preSession`
 * rule refusing the name sees `printf -v 'AWS_KEY[0]'` as a write to
 * AWS_KEY. The refusal is thrown, not collapsed into a status, so the
 * rule's own words reach the user as they do from `export`.
 */
async function assignPrintfTarget(
  session: Session,
  view: SessionView | undefined,
  name: string,
  subscript: string | undefined,
  value: string,
): Promise<'ok' | 'denied' | 'readonly' | 'subscript'> {
  return assignElement(session, view ?? null, name, subscript ?? null, value)
}

/**
 * Print formatted output, honoring GNU printf's format-reuse rules.
 *
 * Supports `%s %c %b %q`, the integer conversions `%d %i %o %u %x %X`,
 * the float conversions `%f %F %e %E %g %G %a %A`, and `%%`, with
 * `- + 0 # (space)` flags, numeric or `*` width/precision, and backslash
 * escapes (including `\u`/`\U`) interpreted once in the same scan. When
 * arguments remain after one pass the format is reused until they are
 * exhausted; a missing argument renders as the empty string / `0`.
 * Integers wrap at 64 bits; `%a` formats at IEEE double precision. The
 * conversion engine itself lives in `printf_format.ts`.
 *
 * With `-v NAME` the formatted text is stored in the shell variable
 * `NAME` (or the array element `NAME[idx]`) instead of written to
 * stdout, matching GNU printf. An unusable `NAME` is rejected before the
 * format runs (status 2); a readonly name or an out-of-range subscript
 * still reports the format's own errors first, then fails with status 1
 * and leaves the variable untouched.
 */
export async function handlePrintf(
  args: string[],
  session: Session,
  view?: SessionView,
): Promise<Result> {
  let target: string | null = null
  let parsed: RegExpExecArray | null = null
  if (args.length >= 2 && args[0] === '-v') {
    target = args[1] ?? ''
    args = args.slice(2)
    parsed = PRINTF_TARGET_RE.exec(target)
    if (parsed === null) {
      // bash validates the name before formatting, so a bad name
      // suppresses the conversion errors the format would report.
      const err = new TextEncoder().encode(`printf: \`${target}': not a valid identifier\n`)
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
      ]
    }
  }
  if (args.length === 0) {
    if (target !== null) {
      const err = new TextEncoder().encode('printf: usage: printf [-v var] format [arguments]\n')
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
      ]
    }
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
  }
  const [output, errors] = runPrintf(args[0] ?? '', args.slice(1))
  const errBytes = errors.length > 0 ? new TextEncoder().encode(errors.join('')) : null
  if (target !== null && parsed !== null) {
    const base = parsed[1] ?? ''
    let status: 'ok' | 'denied' | 'readonly' | 'subscript'
    try {
      status = await assignPrintfTarget(session, view, base, parsed[2], output)
    } catch (err) {
      if (err instanceof ArithError) {
        // The target carries `-i` and the formatted text does not
        // evaluate; bash voices the evaluator after the builtin name.
        const bad = new TextEncoder().encode(errors.join('') + `bash: printf: ${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: bad }),
          new ExecutionNode({ command: 'printf', exitCode: 1, stderr: bad }),
        ]
      }
      if (!(err instanceof PolicyDenied)) throw err
      const denied = new TextEncoder().encode(errors.join('') + `bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: denied }),
        new ExecutionNode({ command: 'printf', exitCode: 1, stderr: denied }),
      ]
    }
    if (status !== 'ok') {
      const detail =
        status === 'readonly'
          ? `bash: ${base}: readonly variable\n`
          : status === 'denied'
            ? `bash: ${base}: permission denied\n`
            : `bash: ${target}: bad array subscript\n`
      const err = new TextEncoder().encode(errors.join('') + detail)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 1, stderr: err }),
      ]
    }
    const exitCode = errors.length > 0 ? 1 : 0
    if (errBytes !== null) {
      return [
        null,
        new IOResult({ exitCode, stderr: errBytes }),
        new ExecutionNode({ command: 'printf', exitCode, stderr: errBytes }),
      ]
    }
    return [null, new IOResult({ exitCode }), new ExecutionNode({ command: 'printf', exitCode })]
  }
  const out = encodeText(output)
  if (errBytes !== null) {
    return [
      out,
      new IOResult({ exitCode: 1, stderr: errBytes }),
      new ExecutionNode({ command: 'printf', exitCode: 1, stderr: errBytes }),
    ]
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
}
