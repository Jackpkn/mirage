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
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { decode, ioToStr } from './io-text.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('decode', () => {
  it('returns empty string for null/undefined', () => {
    expect(decode(null)).toBe('')
    expect(decode(undefined)).toBe('')
  })

  it('decodes utf-8 bytes', () => {
    expect(decode(enc('hello'))).toBe('hello')
  })

  it('replaces invalid utf-8', () => {
    expect(decode(new Uint8Array([0xff]))).toBe('�')
  })
})

describe('ioToStr', () => {
  it('returns stdout only', () => {
    expect(ioToStr(new ExecuteResult(enc('out'), enc(''), 0))).toBe('out')
  })

  it('returns stderr only', () => {
    expect(ioToStr(new ExecuteResult(enc(''), enc('err'), 1))).toBe('err')
  })

  it('combines stdout and stderr', () => {
    expect(ioToStr(new ExecuteResult(enc('out'), enc('err'), 1))).toBe('out\nerr')
  })
})
