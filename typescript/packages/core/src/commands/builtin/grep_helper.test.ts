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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { PatternType } from './constants.ts'
import {
  classifyPattern,
  compilePattern,
  extractRequiredLiteral,
  type FileGlob,
  fileAdmitted,
  grepFilesOnly,
  hasSearchShapingFlags,
  isLiteralPattern,
  isRegexPattern,
  literalPushdownOperand,
  loneOperand,
  mergePatternList,
  NEVER_MATCH,
  NO_FILTERS,
  parseFileGlobs,
  pushdownOperand,
  searchPushdownOk,
  searchQuery,
} from './grep_helper.ts'
import { SPECS } from '../spec/index.ts'
import { FlagView } from '../spec/types.ts'

const ENC = new TextEncoder()

describe('compilePattern', () => {
  it('single pattern keeps regex semantics', () => {
    const pat = compilePattern('fo+')
    expect(pat.test('foo')).toBe(true)
    expect(pat.test('f')).toBe(false)
  })

  it('single fixed string escapes regex chars', () => {
    const pat = compilePattern('a.b', false, true)
    expect(pat.test('xa.by')).toBe(true)
    expect(pat.test('axb')).toBe(false)
  })

  it('newline-separated patterns match any', () => {
    const pat = compilePattern('foo\nbar')
    expect(pat.test('a foo b')).toBe(true)
    expect(pat.test('a bar b')).toBe(true)
    expect(pat.test('baz')).toBe(false)
  })

  it('newline-separated regex alternation grouping', () => {
    const pat = compilePattern('ab+\ncd')
    expect(pat.test('abb')).toBe(true)
    expect(pat.test('xcdy')).toBe(true)
    expect(pat.test('ax')).toBe(false)
  })

  it('newline-separated fixed strings escape each', () => {
    const pat = compilePattern('a.b\nc+', false, true)
    expect(pat.test('xa.by')).toBe(true)
    expect(pat.test('c+')).toBe(true)
    expect(pat.test('axb')).toBe(false)
    expect(pat.test('cc')).toBe(false)
  })

  it('newline-separated whole word applies per pattern', () => {
    const pat = compilePattern('foo\nbar', false, false, true)
    expect(pat.test('a foo b')).toBe(true)
    expect(pat.test('bar.')).toBe(true)
    expect(pat.test('foobar')).toBe(false)
  })

  it('newline-separated ignore case', () => {
    const pat = compilePattern('foo\nbar', true)
    expect(pat.test('FOO')).toBe(true)
    expect(pat.test('Bar')).toBe(true)
  })
})

describe('mergePatternList', () => {
  it('file only', () => {
    expect(mergePatternList(null, ENC.encode('foo\nbar\n'))).toBe('foo\nbar')
  })

  it('combines flag and file patterns', () => {
    expect(mergePatternList('x', ENC.encode('y\nz\n'))).toBe('x\ny\nz')
  })

  it('no file keeps the pattern', () => {
    expect(mergePatternList('x', null)).toBe('x')
  })

  it('empty file yields null (GNU: zero patterns)', () => {
    expect(mergePatternList(null, new Uint8Array())).toBeNull()
  })

  it('single blank line is one empty pattern', () => {
    expect(mergePatternList(null, ENC.encode('\n'))).toBe('')
  })
})

describe('NEVER_MATCH', () => {
  it('matches nothing', () => {
    const pat = compilePattern(NEVER_MATCH)
    expect(pat.test('')).toBe(false)
    expect(pat.test('anything')).toBe(false)
  })
})

describe('isRegexPattern', () => {
  it('treats a newline-joined pattern list as non-literal', () => {
    expect(isRegexPattern('foo\nbar', false)).toBe(true)
    expect(isRegexPattern('foo\nbar', true)).toBe(true)
  })

  it('keeps plain literals non-regex', () => {
    expect(isRegexPattern('foo bar', false)).toBe(false)
  })
})

describe('classifyPattern', () => {
  it('newlines and regex are REGEX, plain text is SIMPLE, fixed is EXACT', () => {
    expect(classifyPattern('foo\nbar', false)).toBe(PatternType.REGEX)
    expect(classifyPattern('foo\nbar', true)).toBe(PatternType.REGEX)
    expect(classifyPattern('foo bar', false)).toBe(PatternType.SIMPLE)
    expect(classifyPattern('foo', true)).toBe(PatternType.EXACT)
    expect(classifyPattern('fo+', false)).toBe(PatternType.REGEX)
  })
})

describe('extractRequiredLiteral', () => {
  it.each([
    ['import.*os', 'import'],
    ['imp.*rt', 'imp'],
    ['^import', 'import'],
    ['colou?r', 'colo'],
    ['[Ee]rror', 'rror'],
    ['\\d+error', 'error'],
    ['config$', 'config'],
    ['a*b', null],
    ['ab', null],
    ['foo|bar', null],
    ['(ab)?cdef', 'cdef'],
  ])('extracts the longest required literal from %s', (pattern, expected) => {
    expect(extractRequiredLiteral(pattern)).toBe(expected)
  })

  it('the extracted literal is present in every matching sample', () => {
    for (const pattern of ['import.*os', 'colou?r', '[Ee]rror', '\\d+error']) {
      const literal = extractRequiredLiteral(pattern)
      expect(literal).not.toBeNull()
      const re = new RegExp(pattern)
      for (const sample of [
        'import sys, os',
        'color',
        'colour',
        'Error here',
        'an error',
        'x42error',
      ]) {
        if (re.test(sample)) expect(sample).toContain(String(literal))
      }
    }
  })
})

describe('searchQuery', () => {
  it('returns the pattern itself when literal', () => {
    expect(searchQuery('import', false)).toBe('import')
    expect(searchQuery('foo', true)).toBe('foo')
  })
  it('extracts a required literal from a regex', () => {
    expect(searchQuery('import.*os', false)).toBe('import')
  })
  it('returns null when no literal can be proven', () => {
    expect(searchQuery('foo|bar', false)).toBeNull()
  })
})

describe('grepFilesOnly', () => {
  it('scans file operands under recursive instead of walking them', async () => {
    // GNU: `grep -rl pat file` treats the operand as a file; only directory
    // operands are walked (search-narrowed candidates arrive as files).
    const readdirFn = (path: string): Promise<string[]> => Promise.reject(new Error(path))
    const statFn = (path: string): Promise<FileStat> =>
      Promise.resolve(new FileStat({ name: path, type: FileType.TEXT }))
    const readBytesFn = (): Promise<Uint8Array> => Promise.resolve(ENC.encode('alpha beta\n'))
    const hits = await grepFilesOnly(readdirFn, statFn, readBytesFn, '/data/notes.txt', 'alpha', {
      recursive: true,
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      countOnly: false,
      fixedString: false,
      onlyMatching: false,
      maxCount: null,
      wholeWord: false,
      basic: true,
    })
    expect(hits).toEqual(['/data/notes.txt'])
  })
})

describe('isLiteralPattern', () => {
  it.each([
    ['abc', false, true],
    ['a-b_c.d', false, false],
    ['plain text', false, true],
    ['a.b', false, false],
    ['a*b', false, false],
    ['^start', false, false],
    ['a.b', true, true],
    ['a\nb', false, false],
    ['a\nb', true, true],
  ])('isLiteralPattern(%j, %j) === %j', (pattern, fixed, expected) => {
    expect(isLiteralPattern(pattern, fixed)).toBe(expected)
  })
})

describe('hasSearchShapingFlags', () => {
  it.each([
    [{}, false],
    [{ i: true }, false],
    [{ F: true }, false],
    [{ r: true }, false],
    [{ v: true }, true],
    [{ n: true }, true],
    [{ c: true }, true],
    [{ args_l: true }, true],
    // A bare `l` key is one the parser never emits: -l is short-only, so
    // it lands on the disambiguated `args_l` dest (`AMBIGUOUS_NAMES`).
    [{ l: true }, false],
    [{ w: true }, true],
    [{ o: true }, true],
    [{ q: true }, true],
    [{ H: true }, true],
    [{ h: true }, true],
    [{ m: '3' }, true],
    [{ A: '2' }, true],
    [{ B: '2' }, true],
    [{ C: '2' }, true],
  ])('hasSearchShapingFlags(%j) === %j', (flags, expected) => {
    expect(
      hasSearchShapingFlags(flags as Record<string, string | boolean | number | string[]>),
    ).toBe(expected)
  })
})

describe('searchPushdownOk', () => {
  it('allows a plain literal, with or without -i', () => {
    expect(searchPushdownOk({}, 'ada')).toBe(true)
    expect(searchPushdownOk({ i: true }, 'ada')).toBe(true)
  })

  it('rejects any shaping flag', () => {
    expect(searchPushdownOk({ v: true }, 'ada')).toBe(false)
    expect(searchPushdownOk({ c: true }, 'ada')).toBe(false)
  })

  it('rejects a regex pattern but allows it under -F', () => {
    expect(searchPushdownOk({}, 'a.b')).toBe(false)
    expect(searchPushdownOk({ F: true }, 'a.b')).toBe(true)
  })
})

function operand(virtual: string, pattern: string | null = null): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual.replace(/^\/+|\/+$/g, ''),
    pattern,
    resolved: pattern === null,
  })
}

const EMAIL_HONORED = ['n', 'args_l', 'w', 'o', 'm']

const TRACES = operand('/traces')
const SESSIONS = operand('/sessions')

describe('pushdownOperand', () => {
  it('admits one concrete operand', () => {
    expect(pushdownOperand([TRACES], {}, 'ada')).toBe(TRACES)
  })

  it('refuses a second operand', () => {
    // The bug this gate exists for: the push-down answered for the first
    // operand and dropped the rest in silence.
    expect(pushdownOperand([TRACES, SESSIONS], {}, 'ada')).toBe(null)
    // Two operands in one family, which a per-operand push-down would have
    // answered twice over.
    expect(pushdownOperand([TRACES, TRACES], {}, 'ada')).toBe(null)
  })

  it('refuses no operand', () => {
    expect(pushdownOperand([], {}, 'ada')).toBe(null)
  })

  it('refuses a glob, a shaping flag and a pattern list', () => {
    expect(pushdownOperand([operand('/traces/*', '*')], {}, 'ada')).toBe(null)
    expect(pushdownOperand([TRACES], { c: true }, 'ada')).toBe(null)
    expect(pushdownOperand([TRACES], {}, 'ada\nbob')).toBe(null)
    expect(pushdownOperand([TRACES], {}, null)).toBe(null)
  })
})

describe('hasSearchShapingFlags honored', () => {
  it('exempts only the named dests', () => {
    // gmail/slack/discord: the provider's search is word-based, so -w is what
    // makes the push-down faithful rather than what breaks it.
    expect(hasSearchShapingFlags({ w: true }, ['w'])).toBe(false)
    expect(hasSearchShapingFlags({ w: true, n: true }, ['w'])).toBe(true)
    // email: the local re-scan implements these, so they ride along.
    expect(hasSearchShapingFlags({ n: true, o: true, m: '3' }, EMAIL_HONORED)).toBe(false)
    // ...but never -v or -c, which need messages the search did not return.
    expect(hasSearchShapingFlags({ v: true }, EMAIL_HONORED)).toBe(true)
    expect(hasSearchShapingFlags({ c: true }, EMAIL_HONORED)).toBe(true)
  })

  it('never exempts the operand rule', () => {
    // An exemption is about flags only: two operands still defer.
    expect(pushdownOperand([TRACES, SESSIONS], { w: true }, 'ada', ['w'])).toBe(null)
    expect(pushdownOperand([TRACES], { w: true }, 'ada', ['w'])).toBe(TRACES)
  })
})

describe('loneOperand', () => {
  it('is the operand rule on its own, for a caller with no pattern', () => {
    // email's find push-down has no grep pattern and no shaping flags.
    expect(loneOperand([TRACES])).toBe(TRACES)
    expect(loneOperand([TRACES, SESSIONS])).toBe(null)
    expect(loneOperand([])).toBe(null)
    expect(loneOperand([operand('/traces/*', '*')])).toBe(null)
  })
})

describe('literalPushdownOperand', () => {
  it('adds the LIKE pattern rule to the same operand rule', () => {
    expect(literalPushdownOperand([TRACES], {}, 'ada')).toBe(TRACES)
    // Everything pushdownOperand refuses, this refuses too.
    expect(literalPushdownOperand([TRACES, SESSIONS], {}, 'ada')).toBe(null)
    expect(literalPushdownOperand([TRACES], { c: true }, 'ada')).toBe(null)
    // Plus the one it adds: LIKE matches a regex literally.
    expect(literalPushdownOperand([TRACES], {}, 'a.b')).toBe(null)
    expect(literalPushdownOperand([TRACES], { F: true }, 'a.b')).toBe(TRACES)
  })
})

function rules(...pairs: [string, boolean][]): {
  fileGlobs: FileGlob[]
  excludeDir: string[]
  text: boolean
} {
  return {
    fileGlobs: pairs.map(([glob, admit]) => ({ glob, admit })),
    excludeDir: [],
    text: false,
  }
}

describe('fileAdmitted', () => {
  it('resolves rules in line order', () => {
    // Pinned against GNU grep 3.11: the last matching rule decides.
    expect(fileAdmitted('/d/a.txt', rules(['*.txt', true], ['*.txt', false]))).toBe(false)
    expect(fileAdmitted('/d/a.txt', rules(['*.txt', false], ['*.txt', true]))).toBe(true)
  })

  it('defaults a no-match file by the first rule', () => {
    // GNU 3.11: a file matching no rule is admitted only when the
    // first rule is an exclude.
    expect(fileAdmitted('/d/a.txt', rules(['*.log', false], ['*.zzz', true]))).toBe(true)
    expect(fileAdmitted('/d/a.txt', rules(['*.zzz', true], ['*.log', false]))).toBe(false)
  })

  it('admits everything with no rules', () => {
    expect(fileAdmitted('/d/a.bin', NO_FILTERS)).toBe(true)
  })
})

describe('parseFileGlobs', () => {
  it('reads dests in typed order', () => {
    const spec = SPECS.grep
    const excFirst = new FlagView({ exclude: ['notes.*'], include: ['*.tex'] }, spec)
    expect(parseFileGlobs(excFirst)).toEqual([
      { glob: 'notes.*', admit: false },
      { glob: '*.tex', admit: true },
    ])
    const incFirst = new FlagView({ include: ['*.tex'], exclude: ['notes.*'] }, spec)
    expect(parseFileGlobs(incFirst)).toEqual([
      { glob: '*.tex', admit: true },
      { glob: 'notes.*', admit: false },
    ])
  })
})
