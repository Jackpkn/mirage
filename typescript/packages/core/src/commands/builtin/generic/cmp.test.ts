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

// cmp's byte counts, byte rendering and diagnostics, pinned on GNU 9.1.
// Mirrors python/tests/commands/builtin/generic/test_cmp.py.

import { describe, expect, it } from 'vitest'
import { cmpGeneric, parseCount, parseSkip, visible } from './cmp.ts'
import { UsageError } from '../../errors.ts'
import { PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'
import type { CommandOpts } from '../../config.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const P1 = new PathSpec({ virtual: '/F/one', directory: '/F', resourcePath: 'one' })
const P2 = new PathSpec({ virtual: '/F/two', directory: '/F', resourcePath: 'two' })

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

async function run(
  first: Uint8Array,
  second: Uint8Array,
  flags: Record<string, unknown> = {},
): Promise<{ out: string; err: string; code: number }> {
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> => {
    const held = p.virtual === P1.virtual ? first : second
    return (async function* gen() {
      await Promise.resolve()
      yield held
    })()
  }
  const [src, io] = await cmpGeneric([P1, P2], { flags } as unknown as CommandOpts, stream)
  return {
    out: DEC.decode(await materialize(src)),
    err: DEC.decode(await materialize(io.stderr)),
    code: io.exitCode,
  }
}

describe('parseCount', () => {
  it('takes digits and GNU size suffixes', () => {
    expect(parseCount('4', '--bytes')).toBe(4)
    expect(parseCount('1K', '--bytes')).toBe(1024)
    expect(parseCount('1kB', '--bytes')).toBe(1000)
    expect(parseCount('1b', '--bytes')).toBe(512)
  })

  it('names the long option it was given', () => {
    // GNU says `invalid --bytes value` for -n and `invalid
    // --ignore-initial value` for -i, with the Try-help line, exit 2.
    let caught: unknown
    try {
      parseCount('abc', '--bytes')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message).toBe(
      "cmp: invalid --bytes value 'abc'\nTry 'cmp --help' for more information.",
    )
    expect((caught as UsageError).exitCode).toBe(2)
  })

  it('rejects an unknown suffix', () => {
    expect(() => parseCount('1Q', '--bytes')).toThrow(UsageError)
  })
})

describe('parseSkip', () => {
  it('takes one count for both files', () => {
    expect(parseSkip('3')).toEqual([3, 3])
  })

  it('takes a colon pair for one each', () => {
    expect(parseSkip('0:3')).toEqual([0, 3])
    expect(parseSkip('1K:2')).toEqual([1024, 2])
  })
})

describe('visible', () => {
  it.each([
    ['b'.charCodeAt(0), 'b'],
    [9, '^I'],
    [1, '^A'],
    [127, '^?'],
    [0xc3, 'M-C'],
    [0xa9, 'M-)'],
    [0x80, 'M-^@'],
  ])('renders %i the cat -v way', (byte, rendered) => {
    expect(visible(byte)).toBe(rendered)
  })
})

describe('cmpGeneric', () => {
  it('switches the word to byte under -b', async () => {
    // GNU counts in `byte` under -b and in `char` otherwise.
    const plain = await run(ENC.encode('abc'), ENC.encode('aXc'))
    const tagged = await run(ENC.encode('abc'), ENC.encode('aXc'), { b: true })
    expect(plain.out).toBe('/F/one /F/two differ: char 2, line 1\n')
    expect(tagged.out).toBe('/F/one /F/two differ: byte 2, line 1 is 142 b 130 X\n')
  })

  it('pads the octal to three columns under -l', async () => {
    const r = await run(bytes(97, 1, 99), bytes(97, 127, 99), { args_l: true })
    expect(r.out).toBe('2   1 177\n')
  })

  it('adds a four-wide char column under -bl', async () => {
    const r = await run(ENC.encode('abc'), ENC.encode('aXc'), { args_l: true, b: true })
    expect(r.out).toBe('2 142 b    130 X\n')
  })

  it('applies the skip per file', async () => {
    // `-i 0:3` keeps all of the first file and drops three bytes of the
    // second, so the very first compared byte differs.
    const r = await run(ENC.encode('abcdefgh'), ENC.encode('abcXefgh'), { i: '0:3' })
    expect(r.out).toBe('/F/one /F/two differ: char 1, line 1\n')
    expect(r.code).toBe(1)
  })

  it('reports EOF on stderr naming the byte and the line', async () => {
    const r = await run(ENC.encode('ab\nc'), ENC.encode('ab\ncdef'))
    expect(r.out).toBe('')
    expect(r.err).toBe('cmp: EOF on /F/one after byte 4, in line 2\n')
    expect(r.code).toBe(1)
  })

  it('drops the line clause from the EOF diagnostic under -l', async () => {
    const r = await run(ENC.encode('aXc'), ENC.encode('aYcdef'), { args_l: true })
    expect(r.out).toBe('2 130 131\n')
    expect(r.err).toBe('cmp: EOF on /F/one after byte 3\n')
    expect(r.code).toBe(1)
  })

  it('reports no difference for a limit inside the common prefix', async () => {
    const r = await run(ENC.encode('abcdef'), ENC.encode('abcXef'), { n: '2' })
    expect(r).toEqual({ out: '', err: '', code: 0 })
  })
})
