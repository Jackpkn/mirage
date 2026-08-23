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

import type { AdmissionRules } from '../types.ts'
import { hasRules, readsArgs, scopesPaths } from './reads.ts'

// Mirrors python/tests/policy/match/test_reads.py.

const EMPTY: AdmissionRules = { allow: null, ask: [], deny: [] }

describe('reads', () => {
  it('hasRules is a profile stating anything', () => {
    expect(hasRules(null)).toBe(false)
    expect(hasRules(EMPTY)).toBe(false)
    expect(hasRules({ ...EMPTY, allow: [] })).toBe(true)
    expect(hasRules({ ...EMPTY, ask: [{ reason: 'r' }] })).toBe(true)
    expect(hasRules({ ...EMPTY, deny: [{ reason: 'r' }] })).toBe(true)
  })

  it('readsArgs only for a rule that reads past the name', () => {
    const rules: AdmissionRules = {
      allow: ['cat', 'git status', '*'],
      deny: [
        { reason: 'no rm', commands: ['rm'] },
        { reason: 'sealed', commands: ['cat'], paths: ['/secret*'] },
        { reason: 'no force', commands: ['git push -f'] },
        { reason: 'repo', commands: ['ls'], mount: '/repo' },
      ],
      ask: [{ reason: 'frozen', paths: ['/locked/*'] }],
    }
    // A token after the name, a path or a mount reads the arguments.
    expect(readsArgs(rules, 'git')).toBe(true)
    expect(readsArgs(rules, 'cat')).toBe(true)
    expect(readsArgs(rules, 'ls')).toBe(true)
    // The command-less frozen rule reads every command's paths.
    expect(readsArgs(rules, 'echo')).toBe(true)
    // With no such rule for it, a command's arguments are unread: the
    // wildcard allow and the bare `rm` deny decide on the name alone.
    expect(
      readsArgs(
        { ...EMPTY, allow: ['*', 'rm'], deny: [{ reason: 'no rm', commands: ['rm'] }] },
        'rm',
      ),
    ).toBe(false)
    expect(readsArgs(null, 'rm')).toBe(false)
  })

  it('scopesPaths is a path rule that applies to this command', () => {
    const named: AdmissionRules = {
      ...EMPTY,
      deny: [
        { reason: 'no rm', commands: ['rm'] },
        { reason: 'sealed', commands: ['cat'], paths: ['/secret*'] },
        { reason: 'repo', commands: ['ls'], mount: '/repo' },
      ],
    }
    // A glob operand of cat or ls must be expanded before the gate reads
    // it: a rule names the command and reads its paths (or its mount).
    expect(scopesPaths(named, 'cat')).toBe(true)
    expect(scopesPaths(named, 'ls')).toBe(true)
    // The bare rm deny and an allow list read the name alone.
    expect(scopesPaths({ ...named, allow: ['rm', '*'] }, 'rm')).toBe(false)
    expect(scopesPaths(named, 'echo')).toBe(false)
    expect(scopesPaths(null, 'cat')).toBe(false)
    // A pure path rule applies to every command, so every command's globs
    // expand: a pattern that only later matches under the scope would
    // otherwise reach the command unjudged.
    const frozen = { reason: 'frozen', paths: ['/locked/*'] }
    expect(scopesPaths({ ...named, ask: [frozen] }, 'rm')).toBe(true)
    expect(scopesPaths({ ...EMPTY, ask: [frozen] }, 'echo')).toBe(true)
  })
})
