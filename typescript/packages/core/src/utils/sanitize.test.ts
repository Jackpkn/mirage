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
import {
  NAME_MAX_BYTES,
  byteLength,
  pathSafeName,
  sanitizeLabel,
  sanitizeName,
} from './sanitize.ts'

describe('sanitizeName', () => {
  it('returns "unknown" for empty/whitespace input', () => {
    expect(sanitizeName('')).toBe('unknown')
    expect(sanitizeName('   ')).toBe('unknown')
  })

  it('replaces unsafe chars with underscore', () => {
    expect(sanitizeName("alice's-channel")).toBe('alice_s-channel')
    expect(sanitizeName('hello#world')).toBe('hello_world')
  })

  it('replaces spaces with underscore', () => {
    expect(sanitizeName('hello world')).toBe('hello_world')
  })

  it('collapses multiple underscores', () => {
    expect(sanitizeName("a''b")).toBe('a_b')
  })

  it('strips leading/trailing underscores', () => {
    expect(sanitizeName('__hello__')).toBe('hello')
  })

  it('truncates to 100 chars', () => {
    const long = 'x'.repeat(150)
    expect(sanitizeName(long)).toBe('x'.repeat(100))
  })

  it('preserves dots and hyphens', () => {
    expect(sanitizeName('foo.bar-baz')).toBe('foo.bar-baz')
  })

  it('preserves unicode letters like python \\w', () => {
    expect(sanitizeName('日本語 docs')).toBe('日本語_docs')
  })
})

describe('pathSafeName', () => {
  it('returns "unknown" for empty/whitespace input', () => {
    expect(pathSafeName('')).toBe('unknown')
    expect(pathSafeName('   ')).toBe('unknown')
  })

  it('preserves spelling and replaces only the path separator', () => {
    expect(pathSafeName("Zecheng's Server")).toBe("Zecheng's Server")
    expect(pathSafeName('a/b')).toBe('a∕b')
  })
})

describe('sanitizeLabel', () => {
  it('replaces unsafe characters and spaces with underscores', () => {
    expect(sanitizeLabel('Hello World', { fallback: 'X', maxLen: 100 })).toBe('Hello_World')
    expect(sanitizeLabel('My/Doc: A\\Test', { fallback: 'X', maxLen: 100 })).toBe('My_Doc_A_Test')
  })

  it('collapses runs and trims the edges', () => {
    expect(sanitizeLabel('Hello   //  World', { fallback: 'X', maxLen: 100 })).toBe('Hello_World')
    expect(sanitizeLabel('__edge__', { fallback: 'X', maxLen: 100 })).toBe('edge')
  })

  it('uses the fallback for a blank label', () => {
    expect(sanitizeLabel('', { fallback: 'Untitled', maxLen: 100 })).toBe('Untitled')
    expect(sanitizeLabel('   ', { fallback: 'No_Subject', maxLen: 80 })).toBe('No_Subject')
  })

  it('ellipsizes past the budget', () => {
    const long = sanitizeLabel('x'.repeat(120), { fallback: 'X', maxLen: 100 })
    expect(long).toHaveLength(100)
    expect(long.endsWith('...')).toBe(true)
    expect(sanitizeLabel('x'.repeat(100), { fallback: 'X', maxLen: 100 })).toBe('x'.repeat(100))
  })

  it('measures the budget in code points, matching python', () => {
    // `String.length` counts UTF-16 units, so 50 ascii plus 26 astral letters
    // reads as 102 there and 76 in python. Measuring in units truncated a
    // label python leaves whole, and sliced through a surrogate pair.
    const label = 'a'.repeat(50) + '\u{10400}'.repeat(26)
    const out = sanitizeLabel(label, { fallback: 'X', maxLen: 100 })
    expect(out).toBe(label)
    expect(out).not.toContain('\uFFFD')
  })

  it('ellipsizes on a code-point boundary', () => {
    // A byte budget wide enough to stay out of the way, so this pins the
    // character budget alone.
    const label = '\u{10400}'.repeat(120)
    const out = sanitizeLabel(label, { fallback: 'X', maxLen: 100, maxBytes: 10_000 })
    expect(Array.from(out)).toHaveLength(100)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\uFFFD')
  })

  it('honors the byte ceiling within the character budget', () => {
    // 100 astral code points is 400 bytes, so a name the character budget
    // accepts is one ext4 and APFS reject with ENAMETOOLONG. The default
    // budget is NAME_MAX, and the cut still lands on a code-point boundary.
    const label = '\u{10400}'.repeat(120)
    const out = sanitizeLabel(label, { fallback: 'X', maxLen: 100 })
    expect(Array.from(out).length).toBeLessThan(100)
    expect(byteLength(out)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\uFFFD')
  })

  it('takes the byte budget as the caller remaining room', () => {
    // What the gdocs/gmail filenames pass: NAME_MAX minus the id, the
    // separators and the suffix.
    const out = sanitizeLabel('会'.repeat(200), { fallback: 'X', maxLen: 100, maxBytes: 60 })
    expect(byteLength(out)).toBeLessThanOrEqual(60)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\uFFFD')
  })

  it('drops the ellipsis when it cannot fit', () => {
    // Three dots and nothing is not a name; a budget this small yields
    // whatever of the label actually fits.
    expect(sanitizeLabel('abcdef', { fallback: 'X', maxLen: 100, maxBytes: 2 })).toBe('ab')
  })

  it('keeps non-ascii letters, matching python', () => {
    // The per-backend copies this replaced used `\w`, which is ascii-only in
    // javascript, so a CJK title became a row of underscores while python --
    // where `\w` is unicode-aware -- kept it.
    expect(sanitizeLabel('日本語の文書', { fallback: 'X', maxLen: 100 })).toBe('日本語の文書')
    expect(sanitizeLabel('Café Notes', { fallback: 'X', maxLen: 100 })).toBe('Café_Notes')
  })
})
