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

const ASCII_DIGITS = /^[0-9]+$/

/**
 * Whether the text is a plain ASCII integer.
 *
 * Python's `int()` also accepts unicode digits and TS `parseInt` accepts a
 * digit-prefixed tail, so this is the one spelling both languages can agree
 * on for numeric path segments.
 */
export function asciiDigits(text: string): boolean {
  return ASCII_DIGITS.test(text)
}

/**
 * How one dynamic path segment encodes its value.
 *
 * `suffix` is the extension the segment carries ('.json'); empty for bare
 * names. `validate` is an extra shape check on the decoded payload; a
 * failing payload means the segment does not match the route at all.
 */
export class Codec {
  readonly suffix: string
  readonly validate: ((text: string) => boolean) | null

  constructor(init: { suffix?: string; validate?: (text: string) => boolean } = {}) {
    this.suffix = init.suffix ?? ''
    this.validate = init.validate ?? null
  }

  /** Decode a path segment, null when it does not fit. */
  decode(text: string): string | null {
    let value = text
    if (this.suffix !== '') {
      if (!value.endsWith(this.suffix)) return null
      value = value.slice(0, -this.suffix.length)
    }
    if (value === '') return null
    if (this.validate !== null && !this.validate(value)) return null
    return value
  }

  /** Render a value back into a path segment. */
  encode(value: string): string {
    return `${value}${this.suffix}`
  }
}

export const RAW = new Codec()
export const JSON_NAME = new Codec({ suffix: '.json' })
export const JSONL_NAME = new Codec({ suffix: '.jsonl' })
export const INT_JSON = new Codec({ suffix: '.json', validate: asciiDigits })
