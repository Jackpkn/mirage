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

import { DEFAULT_DENY_REASON } from '../../policy/types.ts'
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

  it('rejects non-string mount prefixes', () => {
    expect(() => parseSessionProfile({ mounts: ['/repo', 7] })).toThrow(
      /mounts\[1\] must be a string/,
    )
    expect(() => parseSessionProfile({ mounts: 7 })).toThrow(/mounts must be a mapping/)
    expect(() => parseProfileMounts(new Map([[7, 'read']]))).toThrow(/mounts keys must be strings/)
  })

  it('rejects unknown and unshipped fields loudly', () => {
    expect(() => parseSessionProfile({ hidden_paths: {} })).toThrow(/unknown field `hidden_paths`/)
    expect(() => parseSessionProfile({ hiddenPaths: {} })).toThrow(/unknown field/)
    expect(() => parseSessionProfile({ commands: { deny: [] } })).toThrow(
      /unknown field `commands`/,
    )
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
    expect(parseWorkspacePermissions({})).toEqual({ commands: { deny: [] }, paths: { hide: [] } })
  })

  it('requires deny itself to be a list', () => {
    expect(() => parseWorkspacePermissions({ commands: { deny: 'rm' } })).toThrow(
      /deny must be a list/,
    )
  })

  it('rejects profile-only, unshipped and unknown fields', () => {
    expect(() => parseWorkspacePermissions({ mounts: { '/a': 'r' } })).toThrow(
      /unknown field `mounts`/,
    )
    expect(() => parseWorkspacePermissions({ commands: { allow: ['ls'] } })).toThrow(
      /unknown field `allow`/,
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
  it('is paths-only in this rung', () => {
    expect(parseMountPermissions({ paths: { hide: ['*.pem', '.env'] } })).toEqual({
      paths: { hide: ['*.pem', '.env'] },
    })
    expect(parseMountPermissions({})).toEqual({ paths: { hide: [] } })
    expect(() => parseMountPermissions({ commands: { deny: ['rm'] } })).toThrow(
      /unknown field `commands`/,
    )
  })
})
