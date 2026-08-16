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

import { describe, expect, it } from 'vitest'
import { compactJsonBytes, compactJsonText, jsonBytes, jsonlBytes, jsonText } from './json.ts'

const DEC = new TextDecoder()

// Byte-for-byte the fixture in the python twin (tests/core/render/test_json.py).
// Both languages pin the same expected strings, so a change to either renderer
// breaks one of the two.
const PAYLOAD = {
  name: 'café 中文',
  tags: ['a', 'b'],
  meta: { n: 1, ok: true, none: null },
  empty: {},
}

const INDENTED = `{
  "name": "café 中文",
  "tags": [
    "a",
    "b"
  ],
  "meta": {
    "n": 1,
    "ok": true,
    "none": null
  },
  "empty": {}
}`

const COMPACT =
  '{"name":"café 中文","tags":["a","b"],"meta":{"n":1,"ok":true,"none":null},"empty":{}}'

describe('json render kit', () => {
  it('indents two and keeps non-ascii', () => {
    expect(DEC.decode(jsonBytes(PAYLOAD))).toBe(INDENTED)
  })

  it('renders indented text', () => {
    expect(jsonText(PAYLOAD)).toBe(INDENTED)
  })

  it('renders compact text with no separator padding', () => {
    expect(compactJsonText(PAYLOAD)).toBe(COMPACT)
  })

  it('encodes the compact text', () => {
    expect(DEC.decode(compactJsonBytes(PAYLOAD))).toBe(COMPACT)
  })

  it('terminates every jsonl row', () => {
    expect(DEC.decode(jsonlBytes([{ a: 1 }, { b: 2 }]))).toBe('{"a":1}\n{"b":2}\n')
  })

  it('renders no rows as empty', () => {
    expect(jsonlBytes([])).toEqual(new Uint8Array())
  })

  it('keeps the given jsonl order', () => {
    expect(DEC.decode(jsonlBytes([{ i: 2 }, { i: 1 }]))).toBe('{"i":2}\n{"i":1}\n')
  })
})
