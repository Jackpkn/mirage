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
import { evaluateArith } from './arith.ts'
import { ArithError } from './errors.ts'
import type { ElementOps } from './types.ts'

describe('evaluateArith', () => {
  it('follows precedence', () => {
    expect(evaluateArith('1 + 2 * 3', {}).value).toBe(7n)
    expect(evaluateArith('(1 + 2) * 3', {}).value).toBe(9n)
    expect(evaluateArith('2 ** 3 ** 2', {}).value).toBe(512n)
  })

  it('truncates division and modulo toward zero like C', () => {
    expect(evaluateArith('-7 / 2', {}).value).toBe(-3n)
    expect(evaluateArith('7 / -2', {}).value).toBe(-3n)
    expect(evaluateArith('-7 % 2', {}).value).toBe(-1n)
    expect(evaluateArith('7 % -2', {}).value).toBe(1n)
  })

  it('parses hex and octal literals', () => {
    expect(evaluateArith('0x10', {}).value).toBe(16n)
    expect(evaluateArith('010', {}).value).toBe(8n)
    expect(() => evaluateArith('08', {})).toThrow(ArithError)
  })

  it('records assignments as writes', () => {
    expect(evaluateArith('y = 3, y + 2', {})).toEqual({
      value: 5n,
      writes: [{ name: 'y', key: null, value: '3' }],
    })
    expect(evaluateArith('v += 9', { v: '1' })).toEqual({
      value: 10n,
      writes: [{ name: 'v', key: null, value: '10' }],
    })
  })

  it('handles increments and decrements', () => {
    expect(evaluateArith('i++', {})).toEqual({
      value: 0n,
      writes: [{ name: 'i', key: null, value: '1' }],
    })
    expect(evaluateArith('++i', { i: '1' })).toEqual({
      value: 2n,
      writes: [{ name: 'i', key: null, value: '2' }],
    })
    expect(evaluateArith('i--', { i: '5' })).toEqual({
      value: 5n,
      writes: [{ name: 'i', key: null, value: '4' }],
    })
  })

  it('short-circuits side effects', () => {
    expect(evaluateArith('0 && (q = 7)', {})).toEqual({ value: 0n, writes: [] })
    expect(evaluateArith('1 || (q = 7)', {})).toEqual({ value: 1n, writes: [] })
  })

  it('evaluates only the taken ternary arm', () => {
    expect(evaluateArith('1 ? (w = 4) : (w = 9)', {})).toEqual({
      value: 4n,
      writes: [{ name: 'w', key: null, value: '4' }],
    })
    expect(evaluateArith('5 > 3 ? 10 : 20', {}).value).toBe(10n)
  })

  it('resolves variables recursively like bash', () => {
    expect(evaluateArith('x + 1', {}).value).toBe(1n)
    expect(evaluateArith('s * 2', { s: '1+2' }).value).toBe(6n)
    expect(evaluateArith('z + 1', { z: '' }).value).toBe(1n)
  })

  it('normalizes logical and comparison results to 0/1', () => {
    expect(evaluateArith('3 && 4', {}).value).toBe(1n)
    expect(evaluateArith('!5', {}).value).toBe(0n)
    expect(evaluateArith('2 == 2', {}).value).toBe(1n)
    expect(evaluateArith('2 != 2', {}).value).toBe(0n)
  })

  it('supports bitwise operators and shifts', () => {
    expect(evaluateArith('6 & 3', {}).value).toBe(2n)
    expect(evaluateArith('6 | 3', {}).value).toBe(7n)
    expect(evaluateArith('6 ^ 3', {}).value).toBe(5n)
    expect(evaluateArith('~0', {}).value).toBe(-1n)
    expect(evaluateArith('1 << 4', {}).value).toBe(16n)
    expect(evaluateArith('-16 >> 2', {}).value).toBe(-4n)
  })

  it('wraps at 64 bits', () => {
    expect(evaluateArith('(1 << 63) - 1 + 1', {}).value).toBe(-(1n << 63n))
  })

  it('raises ArithError on bad input', () => {
    expect(() => evaluateArith('1 / 0', {})).toThrow(ArithError)
    expect(() => evaluateArith('2 ** -1', {})).toThrow(ArithError)
    expect(() => evaluateArith('1 +', {})).toThrow(ArithError)
    expect(() => evaluateArith('@', {})).toThrow(ArithError)
    expect(() => evaluateArith('r + 1', { r: 'r + 1' })).toThrow(ArithError)
  })

  it('parses base#value literals', () => {
    expect(evaluateArith('16#ff', {}).value).toBe(255n)
    expect(evaluateArith('2#101', {}).value).toBe(5n)
    expect(evaluateArith('8#17', {}).value).toBe(15n)
    expect(evaluateArith('36#z', {}).value).toBe(35n)
    expect(evaluateArith('64#_', {}).value).toBe(63n)
    expect(evaluateArith('16#a + 2#10', {}).value).toBe(12n)
  })

  it('raises ArithError on bad base literals', () => {
    expect(() => evaluateArith('2#9', {})).toThrow(ArithError)
    expect(() => evaluateArith('65#1', {})).toThrow(ArithError)
  })

  it('treats an empty expression as zero', () => {
    expect(evaluateArith('', {})).toEqual({ value: 0n, writes: [] })
  })
})

function fakeElements(): ElementOps {
  const store = new Map([
    ['m a', '7'],
    ['m 0', '4'],
    ['arr 0', '10'],
    ['arr 1', '20'],
  ])
  const ops: ElementOps = {
    resolve(name, subscript, env) {
      if (name === 'm') return subscript.replace(/^["']|["']$/g, '')
      return evaluateArith(subscript, env, 0, ops).value.toString()
    },
    read(name, key) {
      return store.get(`${name} ${key}`) ?? null
    },
  }
  return ops
}

describe('evaluateArith elements', () => {
  it('reads and writes element lvalues', () => {
    const ops = fakeElements()
    expect(evaluateArith('m[a] + arr[0+1]', {}, 0, ops).value).toBe(27n)
    const result = evaluateArith('m[k] = 5, m[k] + 1', {}, 0, ops)
    expect(result.value).toBe(6n)
    expect(result.writes).toEqual([{ name: 'm', key: 'k', value: '5' }])
  })

  it('keeps evaluation order across bare and subscripted targets', () => {
    // A bare name aliases element 0, so `a[0]=1, a=2` must land a=2
    // last and `a=2, a[0]=1` must land a[0]=1 last; a target written
    // twice is recorded once, at its last write.
    const ops = fakeElements()
    const writes = (expr: string) =>
      evaluateArith(expr, {}, 0, ops).writes.map((w) => [w.name, w.key, w.value])
    expect(writes('arr[0] = 1, arr = 2')).toEqual([
      ['arr', '0', '1'],
      ['arr', null, '2'],
    ])
    expect(writes('arr = 2, arr[0] = 1')).toEqual([
      ['arr', null, '2'],
      ['arr', '0', '1'],
    ])
    expect(writes('arr = 1, arr[0] = 2, arr = 3')).toEqual([
      ['arr', '0', '2'],
      ['arr', null, '3'],
    ])
  })

  it('reads a bare array name as element 0', () => {
    const ops = fakeElements()
    expect(evaluateArith('arr + 1', {}, 0, ops).value).toBe(11n)
    expect(evaluateArith('m + 1', {}, 0, ops).value).toBe(5n)
  })

  it('increments elements and strips quoted keys', () => {
    const ops = fakeElements()
    const result = evaluateArith('m[a]++', {}, 0, ops)
    expect(result.value).toBe(7n)
    expect(result.writes[0]?.value).toBe('8')
    expect(evaluateArith('m["a"] - 1', {}, 0, ops).value).toBe(6n)
  })

  it('refuses subscripts with no element callbacks', () => {
    expect(() => evaluateArith('a[0]', {})).toThrow(ArithError)
  })

  it('tokenizes nested brackets', () => {
    const ops = fakeElements()
    expect(evaluateArith('arr[arr[1] - 19]', {}, 0, ops).value).toBe(20n)
  })
})
