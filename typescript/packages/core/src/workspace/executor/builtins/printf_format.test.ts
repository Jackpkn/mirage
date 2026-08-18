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
import { runPrintf } from './printf_format.ts'

// GNU pins taken in debian:stable-slim. `handlePrintf` collapses the
// error list into one stderr blob and a status, so the list itself —
// order and count — is only observable here. Mirrors python's
// tests/workspace/executor/builtins/test_printf_format.py.

describe('runPrintf', () => {
  it('returns errors as a list in argument order', () => {
    const [out, errors] = runPrintf('%d %d\n', ['abc', 'def'])
    expect(out).toBe('0 0\n')
    expect(errors).toEqual(['printf: abc: invalid number\n', 'printf: def: invalid number\n'])
  })

  it('ends the reuse when a cycle consumes nothing', () => {
    // `a%%b` has no conversion, so the first cycle consumes no argument
    // and the excess args are dropped rather than looping forever.
    expect(runPrintf('a%%b\n', ['x', 'y', 'z'])).toEqual(['a%b\n', []])
  })

  it('drops every argument for an empty format', () => {
    expect(runPrintf('', ['a', 'b', 'c'])).toEqual(['', []])
  })

  it('suppresses the rest of the format after a stop from %b', () => {
    expect(runPrintf('[%b][%s]\n', ['ab\\ccd', 'tail'])).toEqual(['[ab', []])
  })

  it('ends every cycle when the stop lands on a later one', () => {
    expect(runPrintf('<%b>', ['one', 'tw\\co', 'three'])).toEqual(['<one><tw', []])
  })

  it.each([
    ['0.5', '0'],
    ['1.5', '2'],
    ['2.5', '2'],
    ['3.5', '4'],
  ])('rounds %s half-to-even at fixed precision', (value, expected) => {
    expect(runPrintf('%.0f', [value])).toEqual([expected, []])
  })

  it('renders a missing argument as the empty string or zero', () => {
    expect(runPrintf('[%s][%d]', [])).toEqual(['[][0]', []])
  })
})
