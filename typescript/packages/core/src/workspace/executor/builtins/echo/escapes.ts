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

import { byteChar } from '../../../../shell/bytes.ts'
import { HEX, OCT, SIMPLE_ESCAPES } from './constants.ts'

/**
 * Process C-style escape sequences for `echo -e`.
 *
 * Single-pass to handle `\\` correctly (`\\b` → a literal `\b`). Supports
 * `\\ \n \t \r \a \b \f \v`, `\xHH` (hex), `\0NNN` (octal) and `\c` (stop
 * output); an unknown escape like `\z` passes through as `\z`. `tr` has
 * its own reader (`commands/builtin/utils/escapes.ts`) because only the
 * shell writes bytes: `\xHH` here names a byte, not a code point.
 */
export function interpretEscapes(text: string): string {
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
    const simple = SIMPLE_ESCAPES[ch]
    if (simple !== undefined) {
      out.push(simple)
      i += 2
    } else if (ch === 'c') {
      break
    } else if (ch === 'x') {
      let digits = ''
      let j = i + 2
      while (j < n && digits.length < 2 && HEX.has(text.charAt(j))) {
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
      while (j < n && digits.length < 3 && OCT.has(text.charAt(j))) {
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
