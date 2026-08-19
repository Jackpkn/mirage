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
import { pathSafeName, sanitizeLabel, sanitizeName } from './sanitize.ts'

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

  it('keeps non-ascii letters, matching python', () => {
    // The per-backend copies this replaced used `\w`, which is ascii-only in
    // javascript, so a CJK title became a row of underscores while python --
    // where `\w` is unicode-aware -- kept it.
    expect(sanitizeLabel('日本語の文書', { fallback: 'X', maxLen: 100 })).toBe('日本語の文書')
    expect(sanitizeLabel('Café Notes', { fallback: 'X', maxLen: 100 })).toBe('Café_Notes')
  })
})
