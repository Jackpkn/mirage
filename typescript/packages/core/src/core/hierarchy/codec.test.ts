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
import { INT_JSON, JSON_NAME, JSONL_NAME, RAW, asciiDigits } from './codec.ts'

describe('hierarchy codec', () => {
  it('RAW takes any nonempty segment', () => {
    expect(RAW.decode('anything')).toBe('anything')
    expect(RAW.decode('')).toBeNull()
  })

  it('JSON_NAME strips the suffix and refuses bare ones', () => {
    expect(JSON_NAME.decode('trace1.json')).toBe('trace1')
    expect(JSON_NAME.decode('trace1.jsonl')).toBeNull()
    expect(JSON_NAME.decode('.json')).toBeNull()
    expect(JSON_NAME.decode('noext')).toBeNull()
    expect(JSON_NAME.encode('trace1')).toBe('trace1.json')
  })

  it('JSONL_NAME is the jsonl twin', () => {
    expect(JSONL_NAME.decode('run.jsonl')).toBe('run')
    expect(JSONL_NAME.decode('run.json')).toBeNull()
  })

  it('INT_JSON requires plain ascii digits', () => {
    expect(INT_JSON.decode('12.json')).toBe('12')
    expect(INT_JSON.decode('007.json')).toBe('007')
    // int() would accept these; parseInt would guess at the first; both
    // languages must refuse them identically.
    expect(INT_JSON.decode('12abc.json')).toBeNull()
    expect(INT_JSON.decode('1.5.json')).toBeNull()
    expect(INT_JSON.decode('١٢.json')).toBeNull()
  })

  it('asciiDigits guards the numeric shape', () => {
    expect(asciiDigits('42')).toBe(true)
    expect(asciiDigits('4x2')).toBe(false)
    expect(asciiDigits('')).toBe(false)
  })
})
