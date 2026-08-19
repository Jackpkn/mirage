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

import type { CommandsSpec } from '../types.ts'
import { hasRules, readsArgs } from './reads.ts'

// Mirrors python/tests/policy/match/test_reads.py.

const EMPTY: CommandsSpec = { allow: null, ask: [], deny: [] }

describe('reads', () => {
  it('hasRules is any tier stating anything', () => {
    expect(hasRules([])).toBe(false)
    expect(hasRules([EMPTY, EMPTY])).toBe(false)
    expect(hasRules([{ ...EMPTY, allow: [] }])).toBe(true)
    expect(hasRules([{ ...EMPTY, ask: [{ reason: 'r' }] }])).toBe(true)
    expect(hasRules([EMPTY, { ...EMPTY, deny: [{ reason: 'r' }] }])).toBe(true)
  })

  it('readsArgs only for a rule that reads past the name', () => {
    const layers: CommandsSpec[] = [
      { ...EMPTY, allow: ['cat', 'git status', '*'] },
      {
        ...EMPTY,
        deny: [
          { reason: 'no rm', commands: ['rm'] },
          { reason: 'sealed', commands: ['cat'], paths: ['/secret*'] },
          { reason: 'no force', commands: ['git push -f'] },
          { reason: 'repo', commands: ['ls'], mount: '/repo' },
        ],
      },
      { ...EMPTY, ask: [{ reason: 'frozen', paths: ['/locked/*'] }] },
    ]
    // A token after the name, a path or a mount reads the arguments.
    expect(readsArgs(layers, 'git')).toBe(true)
    expect(readsArgs(layers, 'cat')).toBe(true)
    expect(readsArgs(layers, 'ls')).toBe(true)
    // The command-less frozen rule reads every command's paths.
    expect(readsArgs(layers, 'echo')).toBe(true)
    // With no such rule for it, a command's arguments are unread: the
    // wildcard allow and the bare `rm` deny decide on the name alone.
    expect(
      readsArgs(
        [
          { ...EMPTY, allow: ['*', 'rm'] },
          { ...EMPTY, deny: [{ reason: 'no rm', commands: ['rm'] }] },
        ],
        'rm',
      ),
    ).toBe(false)
    expect(readsArgs([], 'rm')).toBe(false)
  })
})
