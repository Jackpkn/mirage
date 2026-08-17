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
import { AsyncLineIterator, charWidth } from './async_line_iterator.ts'

async function* fromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const c of chunks) yield c
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('AsyncLineIterator', () => {
  it('splits chunks on newline', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('foo\nbar\nbaz\n')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['foo', 'bar', 'baz'])
  })

  it('reassembles lines across chunk boundaries', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('fo'), encode('o\nba'), encode('r\n')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['foo', 'bar'])
  })

  it('returns trailing unterminated data as the last line', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('foo\nbar')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['foo', 'bar'])
  })

  it('readline returns null at EOF', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('only\n')]))
    const first = await it.readline()
    if (first === null) throw new Error('expected line')
    expect(decode(first)).toBe('only')
    expect(await it.readline()).toBeNull()
  })

  it('handles empty source', async () => {
    const it = new AsyncLineIterator(fromChunks([]))
    expect(await it.readline()).toBeNull()
  })

  it('preserves empty lines', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('a\n\nb\n')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['a', '', 'b'])
  })
})

describe('readChars counts characters, not bytes', () => {
  it('steps one UTF-8 character at a time', () => {
    expect(charWidth(encode('a'))).toBe(1)
    expect(charWidth(encode('é'))).toBe(2)
    expect(charWidth(encode('€'))).toBe(3)
    expect(charWidth(encode('😀'))).toBe(4)
    // Bytes that decode to one replacement character each: a stray
    // continuation byte, a lead the encoding never uses, and a sequence
    // cut short by a byte that cannot continue it.
    expect(charWidth(new Uint8Array([0x80]))).toBe(1)
    expect(charWidth(new Uint8Array([0xff]))).toBe(1)
    expect(charWidth(new Uint8Array([0xe0, 0x41]))).toBe(1)
    expect(charWidth(new Uint8Array([0xe0, 0xa0, 0x41]))).toBe(2)
    // Never past the end of what is there.
    expect(charWidth(new Uint8Array([0xc3]))).toBe(1)
  })

  it('leaves the second character for the next read', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('éx')]))
    const [first, firstDone] = await it.readChars(1, 0x0a)
    expect([decode(first), firstDone]).toEqual(['é', true])
    const [second, secondDone] = await it.readChars(1, 0x0a)
    expect([decode(second), secondDone]).toEqual(['x', true])
  })

  it('joins a character split across chunks', async () => {
    const it = new AsyncLineIterator(
      fromChunks([new Uint8Array([0xc3]), new Uint8Array([0xa9, 0x78])]),
    )
    const [data, done] = await it.readChars(2, null)
    expect([decode(data), done]).toEqual(['\u00e9x', true])
  })

  it('stops at the delimiter and reports a short read at EOF', async () => {
    const stop = new AsyncLineIterator(fromChunks([encode('ab:cd')]))
    expect(await stop.readChars(4, 0x3a).then(([d, ok]) => [decode(d), ok])).toEqual(['ab', true])
    const short = new AsyncLineIterator(fromChunks([encode('ab')]))
    expect(await short.readChars(5, null).then(([d, ok]) => [decode(d), ok])).toEqual(['ab', false])
  })
})
