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

import { PolicyError } from '../../policy/errors.ts'
import { MountMode } from '../../types.ts'
import type { SessionProfile } from './profile.ts'
import { boundHidden, compileProfile, inherit, rebase, resolveProfile, tighten } from './resolve.ts'

const PROFILES: Record<string, SessionProfile> = {
  default: { cwd: '/scratch', env: { PAGER: 'cat' }, mounts: { '/repo': 'r', '/scratch': 'rwx' } },
  reviewer: { extends: 'default', paths: { hide: ['/repo/.env'] }, env: { ROLE: 'reviewer' } },
  auditor: { extends: 'reviewer', cwd: '/repo' },
}

describe('inherit', () => {
  it('copies absent fields and replaces stated ones', () => {
    const reviewer = inherit(PROFILES, 'reviewer')
    expect(reviewer.extends).toBeUndefined()
    expect(reviewer.cwd).toBe('/scratch')
    expect(reviewer.mounts).toEqual({ '/repo': 'r', '/scratch': 'rwx' })
    expect(reviewer.paths).toEqual({ hide: ['/repo/.env'] })
    // A stated field replaces the parent's, it does not merge into it.
    expect(reviewer.env).toEqual({ ROLE: 'reviewer' })
  })

  it('walks a chain root first', () => {
    const auditor = inherit(PROFILES, 'auditor')
    expect(auditor.cwd).toBe('/repo')
    expect(auditor.paths).toEqual({ hide: ['/repo/.env'] })
    expect(auditor.mounts).toEqual({ '/repo': 'r', '/scratch': 'rwx' })
  })

  it('of a root is the root without extends', () => {
    expect(inherit(PROFILES, 'default')).toEqual(PROFILES.default)
  })

  it('rejects unknown names and cycles', () => {
    expect(() => inherit(PROFILES, 'nope')).toThrow(PolicyError)
    expect(() => inherit(PROFILES, 'nope')).toThrow("unknown profile 'nope'")
    expect(() => inherit({ orphan: { extends: 'gone' } }, 'orphan')).toThrow(
      "profile 'orphan' extends unknown profile 'gone'",
    )
    expect(() => inherit({ a: { extends: 'b' }, b: { extends: 'a' } }, 'a')).toThrow(
      'cycle: a -> b -> a',
    )
    // A prototype name is not a profile.
    expect(() => inherit({}, 'toString')).toThrow(PolicyError)
  })
})

describe('resolveProfile', () => {
  it('takes names, objects and the default', () => {
    expect(resolveProfile(PROFILES, 'reviewer')).toEqual(inherit(PROFILES, 'reviewer'))
    expect(resolveProfile(PROFILES, null)).toEqual(PROFILES.default)
    expect(resolveProfile({}, null)).toBeNull()
    const plain: SessionProfile = { cwd: '/x' }
    expect(resolveProfile(PROFILES, plain)).toBe(plain)
    const resolved = resolveProfile(PROFILES, { extends: 'default', cwd: '/x' })
    expect(resolved?.cwd).toBe('/x')
    expect(resolved?.env).toEqual({ PAGER: 'cat' })
    expect(() => resolveProfile(PROFILES, { extends: 'nope' })).toThrow(PolicyError)
  })
})

describe('tighten', () => {
  it('intersects mount grants at the weaker mode', () => {
    const out = tighten(
      { mounts: { '/a': 'rwx', '/b': 'r' } },
      { mounts: { '/a': 'rw', '/c': 'rwx' } },
    )
    expect(out?.mounts).toEqual(new Map([['/a', MountMode.WRITE]]))
  })

  it('mixes the list and mapping forms', () => {
    const ceilings: SessionProfile = { mounts: { '/a': 'rw', '/b': 'r' } }
    const listed: SessionProfile = { mounts: ['/b', '/c'] }
    expect(tighten(ceilings, listed)?.mounts).toEqual(new Map([['/b', MountMode.READ]]))
    expect(tighten(listed, ceilings)?.mounts).toEqual(new Map([['/b', MountMode.READ]]))
    expect(tighten(listed, { mounts: ['/c', '/d'] })?.mounts).toEqual(['/c'])
    // One side unstated leaves the other's grant alone (normalized).
    expect(tighten(ceilings, {})?.mounts).toEqual(
      new Map([
        ['/a', MountMode.WRITE],
        ['/b', MountMode.READ],
      ]),
    )
    expect(tighten({}, listed)?.mounts).toEqual(['/b', '/c'])
  })

  it('unions hides and lets inline presets win', () => {
    const out = tighten(
      {
        cwd: '/scratch',
        env: { PAGER: 'cat', A: '1' },
        paths: { hide: ['/repo/.env', '*.pem'] },
        vars: { hide: ['AWS_*'] },
      },
      {
        cwd: '/repo',
        env: { A: '2' },
        paths: { hide: ['*.pem', '/repo/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      },
    )
    expect(out?.cwd).toBe('/repo')
    expect(out?.env).toEqual({ PAGER: 'cat', A: '2' })
    expect(out?.paths).toEqual({ hide: ['/repo/.env', '*.pem', '/repo/secrets'] })
    expect(out?.vars).toEqual({ hide: ['AWS_*', 'SLACK_TOKEN'] })
  })

  it('with one side missing is the other', () => {
    const p: SessionProfile = { cwd: '/x' }
    expect(tighten(null, p)).toBe(p)
    expect(tighten(p, null)).toBe(p)
    expect(tighten(null, null)).toBeNull()
  })
})

describe('rebase / boundHidden', () => {
  it('joins every entry under the mount root', () => {
    expect(rebase('/repo/', { paths: { hide: ['.env', '*.pem', '/abs/x', 'docs/*'] } })).toEqual([
      '/repo/.env',
      '/repo/*.pem',
      '/repo/abs/x',
      '/repo/docs/*',
    ])
    expect(rebase('repo', null)).toEqual([])
    expect(rebase('/', { paths: { hide: ['a', '/b', ''] } })).toEqual(['/a', '/b', '/'])
  })

  it('combines workspace and rebased mount hides', () => {
    const mounts = new Map([
      ['/repo/', { paths: { hide: ['.env', '*.pem'] } }],
      ['/scratch/', null],
    ])
    expect(
      boundHidden({ commands: { deny: [] }, paths: { hide: ['/shared/finance'] } }, mounts),
    ).toEqual({
      paths: ['/shared/finance', '/repo/.env'],
      patterns: ['/repo/*.pem'],
    })
    expect(boundHidden(null, new Map([['/a/', null]]))).toBeNull()
    expect(boundHidden({ commands: { deny: [] }, paths: { hide: [] } }, new Map())).toBeNull()
  })
})

describe('compileProfile', () => {
  it('turns the document into session fields', () => {
    const out = compileProfile({
      cwd: '/scratch',
      env: { ROLE: 'x' },
      mounts: { '/a': 'rw', '/b': 'r' },
      paths: { hide: ['/a/secrets', '*.key'] },
      vars: { hide: ['SLACK_TOKEN', 'AWS_*'] },
    })
    expect(out.mountModes).toEqual(
      new Map([
        ['/a', MountMode.WRITE],
        ['/b', MountMode.READ],
      ]),
    )
    expect(out.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: ['*.key'] })
    expect(out.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: ['AWS_*'] })
    expect(out.env).toEqual({ ROLE: 'x' })
    expect(out.cwd).toBe('/scratch')
  })

  it('list mounts and the empty profile', () => {
    expect(compileProfile({ mounts: ['/a', '/b'] }).mountModes).toEqual(
      new Map([
        ['/a', MountMode.EXEC],
        ['/b', MountMode.EXEC],
      ]),
    )
    const empty = compileProfile(null)
    expect(empty).toEqual({
      mountModes: null,
      hiddenPaths: null,
      hiddenVars: null,
      env: null,
      cwd: null,
    })
    expect(compileProfile({})).toEqual(empty)
  })
})
