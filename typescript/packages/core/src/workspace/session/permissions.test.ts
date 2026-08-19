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

import { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from '../../policy/types.ts'
import { MountMode } from '../../types.ts'
import {
  parseMountPermissions,
  parseProfileMounts,
  parseSessionProfile,
  parseWorkspacePermissions,
} from './permissions.ts'

describe('parseSessionProfile', () => {
  it('regroups paths and vars and normalizes mounts', () => {
    const p = parseSessionProfile({
      extends: 'default',
      cwd: '/scratch',
      env: { PAGER: 'cat' },
      mounts: { '/repo': 'r', 'scratch/': 'rwx' },
      paths: { hide: ['/repo/.env', '*.pem'] },
      vars: { hide: ['AWS_*'] },
    })
    expect(p.extends).toBe('default')
    expect(p.cwd).toBe('/scratch')
    expect(p.env).toEqual({ PAGER: 'cat' })
    expect(p.mounts).toEqual(
      new Map([
        ['/repo', MountMode.READ],
        ['/scratch', MountMode.EXEC],
      ]),
    )
    expect(p.paths).toEqual({ hide: ['/repo/.env', '*.pem'] })
    expect(p.vars).toEqual({ hide: ['AWS_*'] })
  })

  it('leaves unsaid fields absent so inheritance can tell', () => {
    expect(parseSessionProfile({})).toEqual({})
  })

  it('accepts the list and string mount forms', () => {
    expect(parseSessionProfile({ mounts: ['/repo', 'scratch'] }).mounts).toEqual([
      '/repo',
      '/scratch',
    ])
    expect(parseProfileMounts('/repo')).toEqual(['/repo'])
    expect(parseProfileMounts(new Map([['/a', 'rw']]))).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(parseProfileMounts(null)).toBeNull()
  })

  it('rejects unknown and unshipped fields loudly', () => {
    expect(() => parseSessionProfile({ hidden_paths: {} })).toThrow(/unknown field `hidden_paths`/)
    expect(() => parseSessionProfile({ hiddenPaths: {} })).toThrow(/unknown field/)
    expect(() => parseSessionProfile({ commands: { hide: [] } })).toThrow(/unknown field `hide`/)
    expect(() => parseSessionProfile({ paths: { show: {} } })).toThrow(
      /paths: unknown field `show`/,
    )
    expect(() => parseSessionProfile({ vars: { mask: [] } })).toThrow(/unknown field `mask`/)
    expect(() => parseSessionProfile({ mounts: { '/a': 'w' } })).toThrow(/invalid mount mode/)
    expect(() => parseSessionProfile({ env: { A: 1 } })).toThrow(/env.A must be a string/)
    expect(() => parseSessionProfile([])).toThrow(/must be a mapping/)
  })
})

describe('parseWorkspacePermissions', () => {
  it('accepts deny rules and bare names', () => {
    const w = parseWorkspacePermissions({
      commands: {
        deny: [
          { reason: 'no deletes', commands: ['rm'], paths: ['/repo/*'] },
          'python3',
          { commands: ['shred'] },
        ],
      },
      paths: { hide: ['/shared/finance'] },
    })
    expect(w.commands.deny).toEqual([
      { reason: 'no deletes', commands: ['rm'], paths: ['/repo/*'] },
      { reason: DEFAULT_DENY_REASON, commands: ['python3'] },
      { reason: DEFAULT_DENY_REASON, commands: ['shred'], paths: [] },
    ])
    expect(w.paths).toEqual({ hide: ['/shared/finance'] })
    expect(parseWorkspacePermissions({})).toEqual({
      commands: { allow: null, ask: [], deny: [] },
      paths: { hide: [] },
    })
  })

  it('takes allow patterns and ask rules beside deny', () => {
    const w = parseWorkspacePermissions({
      commands: {
        allow: ['ls', 'git log'],
        ask: ['git push', { reason: 'sign-off', commands: ['rm'], paths: ['/shared/*'] }],
        deny: ['shred'],
      },
    })
    expect(w.commands.allow).toEqual(['ls', 'git log'])
    // A bare ask entry carries the ask arm's default reason, not deny's.
    expect(w.commands.ask).toEqual([
      { reason: DEFAULT_ASK_REASON, commands: ['git push'] },
      { reason: 'sign-off', commands: ['rm'], paths: ['/shared/*'] },
    ])
    // Unstated allow is null (everything installed), not an empty list.
    expect(parseWorkspacePermissions({ commands: { deny: ['rm'] } }).commands.allow).toBeNull()
    const p = parseSessionProfile({ commands: { allow: ['ls'], deny: ['rm'] } })
    expect(p.commands?.allow).toEqual(['ls'])
  })

  it.each([
    { allow: 'ls' },
    { allow: ['ls', ''] },
    { allow: ['ls', '  '] },
    { ask: 'git push' },
    { ask: [''] },
    { deny: [{ reason: 'x', commands: [''] }] },
    { ask: [{ reason: 'x', mount: '/repo' }] },
  ])('refuses scalars, blank patterns and the compiler field: %j', (bad) => {
    // A blank pattern is a prefix of every line, so it would allow, ask
    // about or deny every command; `mount` is the compiler's field.
    expect(() => parseWorkspacePermissions({ commands: bad })).toThrow()
    expect(() => parseSessionProfile({ commands: bad })).toThrow()
  })

  it('rejects profile-only, unshipped and unknown fields', () => {
    expect(() => parseWorkspacePermissions({ mounts: { '/a': 'r' } })).toThrow(
      /unknown field `mounts`/,
    )
    expect(() =>
      parseWorkspacePermissions({ commands: { deny: [{ reason: 'x', command: ['rm'] }] } }),
    ).toThrow(/deny\[0\]: unknown field `command`/)
    expect(() => parseWorkspacePermissions({ vars: { hide: ['X'] } })).toThrow(
      /unknown field `vars`/,
    )
    expect(() => parseWorkspacePermissions({ commands: { deny: [{ reason: 1 }] } })).toThrow(
      /reason must be a string/,
    )
  })
})

describe('parseMountPermissions', () => {
  it('takes paths and ask/deny rules but no allow list', () => {
    expect(parseMountPermissions({ paths: { hide: ['*.pem', '.env'] } })).toEqual({
      paths: { hide: ['*.pem', '.env'] },
      commands: { ask: [], deny: [] },
    })
    expect(parseMountPermissions({})).toEqual({
      paths: { hide: [] },
      commands: { ask: [], deny: [] },
    })
    const m = parseMountPermissions({ commands: { deny: ['git push'], ask: ['git rebase'] } })
    expect(m.commands?.deny).toEqual([{ reason: DEFAULT_DENY_REASON, commands: ['git push'] }])
    expect(m.commands?.ask).toEqual([{ reason: DEFAULT_ASK_REASON, commands: ['git rebase'] }])
    // What a session can see is the session's property, not an
    // operand's: a mount tier has no allow list.
    expect(() => parseMountPermissions({ commands: { allow: ['ls'] } })).toThrow(
      /unknown field `allow`/,
    )
  })
})
