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
import type { SessionProfile } from './permissions.ts'
import {
  applyProfile,
  boundCommands,
  boundHidden,
  compileCommands,
  compileProfile,
  inherit,
  narrow,
  rebase,
  resolveProfile,
  tighten,
} from './resolve.ts'
import { Session } from './session.ts'
import { VarAttr } from '../../shell/variable.ts'

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
      commands: null,
    })
    expect(compileProfile({})).toEqual(empty)
  })

  it('grants infrastructure beside listed mounts', () => {
    // A ceiling must never lock an agent out of the scratch root, /dev
    // or the history view, so they ride along at EXEC when the profile
    // lists mounts, and are not invented when it lists none.
    const infra = ['/', '/dev']
    expect(compileProfile({ mounts: { '/a': 'r' } }, infra).mountModes).toEqual(
      new Map([
        ['/a', MountMode.READ],
        ['/', MountMode.EXEC],
        ['/dev', MountMode.EXEC],
      ]),
    )
    expect(compileProfile({ mounts: { '/': 'r' } }, infra).mountModes?.get('/')).toBe(
      MountMode.READ,
    )
    expect(compileProfile({ cwd: '/a' }, infra).mountModes).toBeNull()
  })
})

describe('narrow / applyProfile', () => {
  it('narrow stamps the uneditable fields, applyProfile seeds the rest', () => {
    const compiled = compileProfile({
      cwd: '/a',
      env: { ROLE: 'x' },
      mounts: { '/a': 'rw' },
      paths: { hide: ['/a/secrets'] },
      vars: { hide: ['SLACK_TOKEN'] },
    })
    const narrowed = new Session({ sessionId: 's1' })
    narrow(narrowed, compiled)
    expect(narrowed.mountModes).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(narrowed.mountModes).not.toBe(compiled.mountModes)
    expect(narrowed.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(narrowed.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    expect(narrowed.cwd).toBe('/')
    expect(narrowed.env.ROLE).toBeUndefined()
    const applied = new Session({ sessionId: 's2' })
    applyProfile(applied, compiled)
    expect(applied.mountModes).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(applied.cwd).toBe('/a')
    expect(applied.env.ROLE).toBe('x')
    expect(applied.vars.ROLE?.attrs.has(VarAttr.Export)).toBe(true)
  })
})

describe('command tiers', () => {
  it('inherit replaces the commands block whole', () => {
    const profiles: Record<string, SessionProfile> = {
      base: { commands: { allow: ['ls', 'git'], deny: [{ reason: 'no', commands: ['rm'] }] } },
      child: { extends: 'base', commands: { allow: ['ls'], deny: [] } },
      grand: { extends: 'child', cwd: '/x' },
    }
    // A stated block replaces the parent's (field inheritance), an
    // absent one is inherited; safety comes from tightening, not here.
    expect(inherit(profiles, 'child').commands).toEqual({ allow: ['ls'], deny: [] })
    expect(inherit(profiles, 'grand').commands).toEqual({ allow: ['ls'], deny: [] })
  })

  it('tighten intersects allow and unions ask and deny', () => {
    const base: SessionProfile = {
      commands: {
        allow: ['ls', 'git', 'cat'],
        ask: [{ reason: 'a', commands: ['git push'] }],
        deny: [{ reason: 'no', commands: ['rm'] }],
      },
    }
    const inline: SessionProfile = {
      commands: { allow: ['git log', 'cat', 'wc'], deny: [{ reason: 'no', commands: ['mv'] }] },
    }
    const out = tighten(base, inline)
    expect(out?.commands).toEqual({
      allow: ['git log', 'cat'],
      ask: [{ reason: 'a', commands: ['git push'] }],
      deny: [
        { reason: 'no', commands: ['rm'] },
        { reason: 'no', commands: ['mv'] },
      ],
    })
    // One side without a list leaves the other's alone; one side
    // without a block leaves the other's block.
    const only = tighten(base, { commands: { deny: [{ reason: 'x', commands: ['cp'] }] } })
    expect(only?.commands?.allow).toEqual(['ls', 'git', 'cat'])
    expect(tighten(base, { cwd: '/x' })?.commands).toEqual(base.commands)
    expect(tighten({ cwd: '/x' }, inline)?.commands).toEqual(inline.commands)
  })

  it('compileCommands scopes a mount tier and rebases its paths', () => {
    expect(compileCommands(null)).toBeNull()
    expect(compileCommands({ deny: [] })).toBeNull()
    // A workspace or profile tier compiles as written.
    expect(compileCommands({ allow: ['ls'], deny: [{ reason: 'no', commands: ['rm'] }] })).toEqual({
      allow: ['ls'],
      ask: [],
      deny: [{ reason: 'no', commands: ['rm'] }],
    })
    // A mount tier: every rule scoped to the mount root, its paths
    // rebased under it, no allow list.
    expect(
      compileCommands(
        {
          ask: [{ reason: 'a', commands: ['git rebase'] }],
          deny: [{ reason: 'ro', commands: ['rm'], paths: ['*.lock', '/docs'] }],
        },
        '/repo/',
      ),
    ).toEqual({
      allow: null,
      ask: [{ reason: 'a', commands: ['git rebase'], paths: [], mount: '/repo' }],
      deny: [
        { reason: 'ro', commands: ['rm'], paths: ['/repo/*.lock', '/repo/docs'], mount: '/repo' },
      ],
    })
    // An empty mount block is nothing to evaluate.
    expect(compileCommands({ ask: [], deny: [] }, '/repo')).toBeNull()
  })

  it('boundCommands lists mount tiers then the workspace', () => {
    const layers = boundCommands(
      { commands: { allow: ['ls'], deny: [] }, paths: { hide: [] } },
      new Map([
        [
          '/repo/',
          { paths: { hide: [] }, commands: { deny: [{ reason: 'no', commands: ['git push'] }] } },
        ],
        ['/scratch/', null],
        ['/s3/', { paths: { hide: ['.env'] } }],
      ]),
    )
    expect(layers).toHaveLength(2)
    expect(layers[0]?.deny[0]?.mount).toBe('/repo')
    expect(layers[1]).toEqual({ allow: ['ls'], ask: [], deny: [] })
    expect(boundCommands(null, new Map([['/a/', null]]))).toEqual([])
    expect(boundCommands({ commands: { deny: [] }, paths: { hide: [] } }, new Map())).toEqual([])
  })

  it('compileProfile and narrow carry the command tier', () => {
    const compiled = compileProfile({
      commands: { allow: ['ls'], ask: [{ reason: 'a', commands: ['git'] }], deny: [] },
    })
    expect(compiled.commands).toEqual({
      allow: ['ls'],
      ask: [{ reason: 'a', commands: ['git'] }],
      deny: [],
    })
    expect(compileProfile({ cwd: '/x' }).commands).toBeNull()
    const session = new Session({ sessionId: 's' })
    narrow(session, compiled)
    expect(session.commands).toEqual(compiled.commands)
    expect(session.commandLayers).toEqual([compiled.commands])
    const bound = { allow: null, ask: [], deny: [{ reason: 'x' }] }
    session.boundCommands = [bound]
    expect(session.commandLayers).toEqual([bound, compiled.commands])
  })
})
