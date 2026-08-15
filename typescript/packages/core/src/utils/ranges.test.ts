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

import { isUnsatisfiableRange, rangeHeader, sliceWindow, windowIfUnranged } from './ranges.js'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const DATA = ENC.encode('0123456789')

describe('rangeHeader', () => {
  it('needs no header for the whole file', () => {
    expect(rangeHeader(0, null)).toBeNull()
  })

  it('is inclusive at both ends of a bounded window', () => {
    // HTTP ranges name the last byte, not the one after it, so a 4-byte window
    // from 2 ends at 5.
    expect(rangeHeader(2, 4)).toBe('bytes=2-5')
  })

  it('leaves the end blank on an open-ended window', () => {
    expect(rangeHeader(7, null)).toBe('bytes=7-')
  })

  it('names the same offset twice for a single byte', () => {
    expect(rangeHeader(3, 1)).toBe('bytes=3-3')
  })

  it('refuses a negative offset', () => {
    expect(() => rangeHeader(-1, 4)).toThrow(RangeError)
  })

  it('refuses a negative size', () => {
    expect(() => rangeHeader(0, -4)).toThrow(RangeError)
  })

  it('refuses a zero-length window', () => {
    // bytes=2--1 is malformed and no header means the opposite of what was
    // asked, so the caller has to short-circuit instead.
    expect(() => rangeHeader(2, 0)).toThrow(RangeError)
  })
})

describe('sliceWindow', () => {
  it('slices a bounded window', () => {
    expect(DEC.decode(sliceWindow(DATA, 2, 4))).toBe('2345')
  })

  it('slices to the end', () => {
    expect(DEC.decode(sliceWindow(DATA, 7, null))).toBe('789')
  })

  it('slices the whole thing', () => {
    expect(sliceWindow(DATA, 0, null)).toEqual(DATA)
  })

  it('stops at the end when the window runs past it', () => {
    expect(DEC.decode(sliceWindow(DATA, 8, 99))).toBe('89')
  })

  it('is empty from past the end', () => {
    expect(sliceWindow(DATA, 99, 4)).toEqual(new Uint8Array(0))
  })
})

describe('isUnsatisfiableRange', () => {
  // The point of the predicate: a POSIX read at or past EOF is empty, an HTTP
  // store answers 416, and no two clients spell the refusal the same way.
  it('recognizes the aws sdk shape', () => {
    const err = Object.assign(new Error('InvalidRange'), {
      name: 'InvalidRange',
      $metadata: { httpStatusCode: 416 },
    })
    expect(isUnsatisfiableRange(err)).toBe(true)
  })

  it('recognizes a bare status, with no code at all', () => {
    expect(isUnsatisfiableRange({ status: 416 })).toBe(true)
    expect(isUnsatisfiableRange({ statusCode: 416 })).toBe(true)
  })

  it('recognizes the code without a status', () => {
    expect(isUnsatisfiableRange(Object.assign(new Error('nope'), { Code: 'InvalidRange' }))).toBe(
      true,
    )
  })

  it('falls back to the status line a plain http store leaves', () => {
    expect(isUnsatisfiableRange(new Error('416 Range Not Satisfiable'))).toBe(true)
  })

  it('recognizes the seek a reader without a header raises', () => {
    // hf and nextcloud open an OpenDAL file object and seek, so a window
    // past EOF surfaces as the seek failing rather than as a status.
    expect(
      isUnsatisfiableRange(new Error('invalid seek to a position beyond the end of the range')),
    ).toBe(true)
  })

  it('does not swallow an ordinary seek failure', () => {
    expect(isUnsatisfiableRange(new Error('invalid seek: bad whence'))).toBe(false)
  })

  it('does not swallow a real failure', () => {
    // Anything broader here would turn a missing object or a denied request
    // into a silent empty read, which is the bug this guards against.
    const notFound = Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    expect(isUnsatisfiableRange(notFound)).toBe(false)
    expect(isUnsatisfiableRange(new Error('AccessDenied'))).toBe(false)
    expect(isUnsatisfiableRange({ status: 500 })).toBe(false)
    expect(isUnsatisfiableRange(null)).toBe(false)
    expect(isUnsatisfiableRange(undefined)).toBe(false)
  })
})

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('windowIfUnranged', () => {
  it('trusts a 206 as already the window', () => {
    expect(text(windowIfUnranged(bytes('234'), 206, 2, 3))).toBe('234')
  })

  // RFC 9110 lets a server answer the whole representation to a Range
  // request, and a CDN in front of one may. Without this the caller gets the
  // entire file for what it asked to be a window.
  it('slices a 200 because the server ignored the range', () => {
    expect(text(windowIfUnranged(bytes('0123456789'), 200, 2, 3))).toBe('234')
  })

  it('slices a 200 to EOF from the offset', () => {
    expect(text(windowIfUnranged(bytes('0123456789'), 200, 7, null))).toBe('789')
  })

  it('answers empty for a 200 whose offset is past EOF', () => {
    expect(text(windowIfUnranged(bytes('abc'), 200, 500, 10))).toBe('')
  })
})
