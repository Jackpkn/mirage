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

import { ArithError } from '../../shell/errors.ts'
import { VarAttr } from '../../shell/variable.ts'
import { Session } from './session.ts'
import {
  assignElement,
  elementIndex,
  elementIsSet,
  sessionElements,
  stripKeyQuotes,
} from './elements.ts'
import { seedVar, setAttr } from './state.ts'

function makeSession(): Session {
  const session = new Session({ sessionId: 's', cwd: '/' })
  seedVar(session, 'm', { a: '1', k5: '9', '0': 'z' })
  seedVar(session, 'arr', ['10', '20', '30'])
  seedVar(session, 's5', '5')
  seedVar(session, 'i', '1')
  return session
}

describe('stripKeyQuotes', () => {
  it('removes one surrounding pair only', () => {
    expect(stripKeyQuotes('"x"')).toBe('x')
    expect(stripKeyQuotes("'x'")).toBe('x')
    expect(stripKeyQuotes('x')).toBe('x')
    expect(stripKeyQuotes('"x')).toBe('"x')
    expect(stripKeyQuotes('""')).toBe('')
  })
})

describe('elementIndex', () => {
  it('resolves ints, arithmetic, and errors to zero', () => {
    expect(elementIndex('3', {})).toBe(3)
    expect(elementIndex(' -2 ', {})).toBe(-2)
    expect(elementIndex('i+1', { i: '1' })).toBe(2)
    // An unresolvable expression indexes element 0, bash's
    // unset-name-is-zero arithmetic rule.
    expect(elementIndex('$bad', {})).toBe(0)
  })
})

describe('sessionElements', () => {
  it('resolves associative subscripts literally', () => {
    const ops = sessionElements(makeSession())
    expect(ops.resolve('m', 'a', {})).toBe('a')
    expect(ops.resolve('m', '"a"', {})).toBe('a')
    // A key spelled like arithmetic stays a key.
    expect(ops.resolve('m', '1+1', {})).toBe('1+1')
  })

  it('resolves indexed subscripts as arithmetic with negative wrap', () => {
    const ops = sessionElements(makeSession())
    expect(ops.resolve('arr', '1+1', {})).toBe('2')
    expect(ops.resolve('arr', 'i', { i: '2' })).toBe('2')
    expect(ops.resolve('arr', '-1', {})).toBe('2')
    expect(() => ops.resolve('arr', '-9', {})).toThrow(ArithError)
  })

  it('reads by kind, scalars answering as element 0', () => {
    const ops = sessionElements(makeSession())
    expect(ops.read('m', 'a')).toBe('1')
    expect(ops.read('m', 'zz')).toBeNull()
    expect(ops.read('arr', '1')).toBe('20')
    expect(ops.read('arr', '9')).toBeNull()
    expect(ops.read('s5', '0')).toBe('5')
    expect(ops.read('s5', '1')).toBeNull()
    expect(ops.read('missing', '0')).toBeNull()
  })
})

describe('elementIsSet', () => {
  it('answers key membership, index presence, and bare element 0', () => {
    const session = makeSession()
    expect(elementIsSet(session, 'm[a]')).toBe(true)
    expect(elementIsSet(session, 'm[zz]')).toBe(false)
    // The subscript is the key verbatim, never arithmetic.
    expect(elementIsSet(session, 'm[1+1]')).toBe(false)
    expect(elementIsSet(session, 'm[@]')).toBe(true)
    expect(elementIsSet(session, 'arr[2]')).toBe(true)
    expect(elementIsSet(session, 'arr[9]')).toBe(false)
    expect(elementIsSet(session, 'arr[@]')).toBe(true)
    // A bare name over an array checks element 0 (the literal key "0"
    // for an associative one).
    expect(elementIsSet(session, 'm')).toBe(true)
    expect(elementIsSet(session, 'arr')).toBe(true)
    expect(elementIsSet(session, 's5')).toBe(true)
    expect(elementIsSet(session, 'missing')).toBe(false)
    expect(elementIsSet(session, 'not a ref')).toBe(false)
  })
})

describe('assignElement', () => {
  it('writes associative keys, appends, and refuses the empty key', async () => {
    const session = makeSession()
    expect(await assignElement(session, null, 'm', 'b', '2')).toBe('ok')
    expect(await assignElement(session, null, 'm', 'b', 'x', true)).toBe('ok')
    // A bare target over an associative array is the key "0".
    expect(await assignElement(session, null, 'm', null, 'top')).toBe('ok')
    expect(await assignElement(session, null, 'm', '', 'v')).toBe('subscript')
    expect(session.assocs.m?.b).toBe('2x')
    expect(session.assocs.m?.['0']).toBe('top')
  })

  it('writes indexed elements, migrates scalars, and reports statuses', async () => {
    const session = makeSession()
    setAttr(session, 'ro', VarAttr.Readonly)
    expect(await assignElement(session, null, 'arr', '1', 'X')).toBe('ok')
    expect(await assignElement(session, null, 'arr', '-1', 'Y')).toBe('ok')
    expect(await assignElement(session, null, 'arr', '-9', 'n')).toBe('subscript')
    // An existing scalar migrates to element 0 under a subscript.
    seedVar(session, 'sc', 'base')
    expect(await assignElement(session, null, 'sc', '1', 'one')).toBe('ok')
    expect(await assignElement(session, null, 'ro', '0', 'x')).toBe('readonly')
    expect(session.arrays.arr).toEqual(['10', 'X', 'Y'])
    expect(session.arrays.sc).toEqual(['base', 'one'])
  })
})
