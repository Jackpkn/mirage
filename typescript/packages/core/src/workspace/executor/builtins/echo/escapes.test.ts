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
import { interpretEscapes } from './escapes.ts'

// Direct port of tests/workspace/executor/test_escapes.py, which covers
// Python's _interpret_escapes in mirage/workspace/executor/builtins/echo/escapes.py.
// This file used to import tr's reader instead, which is how tr ended up
// with echo's grammar: every echo-only rule below (\xHH, \c, \z passing
// through) was asserted against the wrong command. tr's own rules are
// pinned in commands/builtin/utils/escapes.test.ts.
describe('interpretEscapes (port of tests/workspace/executor/test_escapes.py)', () => {
  it('newline', () => {
    expect(interpretEscapes('a\\nb')).toBe('a\nb')
  })

  it('tab', () => {
    expect(interpretEscapes('a\\tb')).toBe('a\tb')
  })

  it('carriage return', () => {
    expect(interpretEscapes('\\r')).toBe('\r')
  })

  it('bell', () => {
    expect(interpretEscapes('\\a')).toBe('\x07')
  })

  it('backspace', () => {
    expect(interpretEscapes('\\b')).toBe('\b')
  })

  it('form feed', () => {
    expect(interpretEscapes('\\f')).toBe('\f')
  })

  it('vertical tab', () => {
    expect(interpretEscapes('\\v')).toBe('\v')
  })

  it('backslash', () => {
    expect(interpretEscapes('a\\\\b')).toBe('a\\b')
  })

  it('escaped backslash does not re-escape the next character', () => {
    expect(interpretEscapes('\\\\n')).toBe('\\n')
  })

  it('hex escape', () => {
    expect(interpretEscapes('\\x41')).toBe('A')
  })

  it('short hex escape', () => {
    expect(interpretEscapes('\\x9')).toBe('\t')
  })

  it('bare \\x is literal', () => {
    expect(interpretEscapes('\\x')).toBe('\\x')
  })

  it('octal escape', () => {
    expect(interpretEscapes('\\0101')).toBe('A')
  })

  it('bare \\0 is NUL', () => {
    expect(interpretEscapes('\\0')).toBe('\0')
  })

  it('\\c stops output', () => {
    expect(interpretEscapes('hello\\cworld')).toBe('hello')
  })

  it('unknown escape passes through with its backslash', () => {
    expect(interpretEscapes('\\z')).toBe('\\z')
  })

  it('plain text', () => {
    expect(interpretEscapes('hello world')).toBe('hello world')
  })

  it('empty', () => {
    expect(interpretEscapes('')).toBe('')
  })

  it('trailing backslash', () => {
    expect(interpretEscapes('end\\')).toBe('end\\')
  })

  it('mixed', () => {
    expect(interpretEscapes('a\\tb\\nc\\\\d')).toBe('a\tb\nc\\d')
  })
})
