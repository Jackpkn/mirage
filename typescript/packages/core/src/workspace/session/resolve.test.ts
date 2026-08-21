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

import { DEFAULT_ASK_REASON } from '../../policy/constants.ts'
import { PolicyError } from '../../policy/errors.ts'
import { MountMode } from '../../types.ts'
import { parseSessionProfile, type SessionProfile } from './permissions.ts'
import {
  applyProfile,
  compileCommands,
  compileProfile,
  narrow,
  resolveProfile,
  withInline,
} from './resolve.ts'
import { Session } from './session.ts'
import { VarAttr } from '../../shell/variable.ts'

const PROFILES: Record<string, SessionProfile> = {
  default: parseSessionProfile({
    cwd: '/scratch',
    env: { PAGER: 'cat' },
    mounts: { '/repo': 'r', '/scratch': 'rwx' },
  }),
  reviewer: parseSessionProfile({
    paths: { hide: ['/repo/.env'] },
    env: { ROLE: 'reviewer' },
  }),
}

describe('resolveProfile', () => {
  it('names objects and the default', () => {
    expect(resolveProfile(PROFILES, 'reviewer')).toBe(PROFILES.reviewer)
    expect(resolveProfile(PROFILES, null)).toBe(PROFILES.default)
    expect(resolveProfile({}, null)).toBeNull()
    const plain: SessionProfile = { cwd: '/x' }
    expect(resolveProfile(PROFILES, plain)).toBe(plain)
  })

  it('refuses an unknown name', () => {
    expect(() => resolveProfile(PROFILES, 'nope')).toThrow(PolicyError)
    expect(() => resolveProfile(PROFILES, 'nope')).toThrow('unknown profile "nope"')
  })
})

describe('withInline', () => {
  it('takes the weaker mode per mount', () => {
    const base = parseSessionProfile({ mounts: { '/a': 'rwx', '/b': 'r' } })
    const inline = parseSessionProfile({ mounts: { '/a': 'rw', '/c': 'rwx' } })
    const out = withInline(base, inline)
    // Every prefix either side names survives; a mount only the inline
    // document names is not a grant, since a mount the role never named
    // was already reachable at its own mode.
    expect(out?.mounts?.get('/a')?.mode).toBe(MountMode.WRITE)
    expect(out?.mounts?.get('/b')?.mode).toBe(MountMode.READ)
    expect(out?.mounts?.get('/c')?.mode).toBe(MountMode.EXEC)
  })

  it('unions hides and lets inline presets win', () => {
    const out = withInline(
      parseSessionProfile({
        cwd: '/scratch',
        env: { PAGER: 'cat', A: '1' },
        paths: { hide: ['/repo/.env', '*.pem'] },
        vars: { hide: ['AWS_*'] },
      }),
      parseSessionProfile({
        cwd: '/repo',
        env: { A: '2' },
        paths: { hide: ['*.pem', '/repo/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      }),
    )
    expect(out?.cwd).toBe('/repo')
    expect(out?.env).toEqual({ PAGER: 'cat', A: '2' })
    expect(out?.paths).toEqual({ hide: ['/repo/.env', '*.pem', '/repo/secrets'] })
    expect(out?.vars).toEqual({ hide: ['AWS_*', 'SLACK_TOKEN'] })
  })

  it('merges one mount section', () => {
    const base = parseSessionProfile({
      mounts: {
        '/repo': {
          mode: 'rw',
          commands: { deny: ['rm'] },
          paths: { hide: ['/repo/.env'] },
        },
      },
    })
    const inline = parseSessionProfile({
      mounts: {
        '/repo': { commands: { ask: ['git push'] }, paths: { hide: ['/repo/secrets'] } },
      },
    })
    const entry = withInline(base, inline)?.mounts?.get('/repo')
    expect(entry?.mode).toBe(MountMode.WRITE)
    expect(entry?.commands?.deny?.map((r) => r.commands)).toEqual([['rm']])
    expect(entry?.commands?.ask?.map((r) => r.commands)).toEqual([['git push']])
    expect(entry?.paths).toEqual({ hide: ['/repo/.env', '/repo/secrets'] })
  })

  it('with one side missing is the other', () => {
    const p: SessionProfile = { cwd: '/x' }
    expect(withInline(null, p)).toBe(p)
    expect(withInline(p, null)).toBe(p)
    expect(withInline(null, null)).toBeNull()
  })

  it('adds ask and deny but refuses an allow list', () => {
    const base = parseSessionProfile({
      commands: { allow: ['ls', 'git', 'cat'], ask: ['git push'], deny: ['rm'] },
    })
    const inline = parseSessionProfile({
      commands: { deny: [{ reason: 'no', commands: ['mv'] }] },
    })
    const out = withInline(base, inline)
    // The allow list is the role's alone, and the added rules land after
    // it: an inline document restricts, it never installs.
    expect(out?.commands?.allow).toEqual(['ls', 'git', 'cat'])
    expect(out?.commands?.ask?.map((r) => r.commands)).toEqual([['git push']])
    expect(out?.commands?.deny?.map((r) => r.commands)).toEqual([['rm'], ['mv']])
    expect(() => withInline(base, parseSessionProfile({ commands: { allow: ['wc'] } }))).toThrow(
      'not an allow list',
    )
    // And with no role to add to: the refusal belongs to where the
    // document was written, so a workspace that happens to declare no
    // default role must not quietly accept what one with a role refuses.
    expect(() => withInline(null, parseSessionProfile({ commands: { allow: ['wc'] } }))).toThrow(
      'not an allow list',
    )
  })

  it('leaves a stated block alone when the other is bare', () => {
    const base = parseSessionProfile({ commands: { allow: ['ls'] } })
    expect(withInline(base, { cwd: '/x' })?.commands).toEqual(base.commands)
    const inline = parseSessionProfile({ commands: { deny: ['rm'] } })
    expect(withInline({ cwd: '/x' }, inline)?.commands).toEqual(inline.commands)
  })
})

describe('compileCommands', () => {
  it("lists mount rules before the role's own", () => {
    const rules = compileCommands(
      parseSessionProfile({
        commands: { allow: ['ls'], deny: ['shutdown'] },
        mounts: {
          '/repo': {
            commands: {
              ask: ['git rebase'],
              deny: [{ reason: 'ro', commands: { rm: ['/repo/*.lock'] } }],
            },
          },
          '/scratch': 'r',
        },
      }),
    )
    expect(rules?.allow).toEqual(['ls'])
    // Every mount rule carries the root it was written under, which is
    // what scopes it to a line working inside that mount; its paths are
    // kept exactly as typed.
    expect(rules?.deny[0]).toEqual({
      reason: 'ro',
      commands: ['rm'],
      paths: ['/repo/*.lock'],
      mount: '/repo',
    })
    expect(rules?.deny[1]?.commands).toEqual(['shutdown'])
    expect(rules?.deny[1]?.mount).toBeUndefined()
    expect(rules?.ask[0]?.commands).toEqual(['git rebase'])
    expect(rules?.ask[0]?.mount).toBe('/repo')
    expect(rules?.ask[0]?.paths).toBeUndefined()
  })

  it('is null when the role states no rules', () => {
    expect(compileCommands({})).toBeNull()
    expect(compileCommands(parseSessionProfile({ commands: {} }))).toBeNull()
    expect(compileCommands(parseSessionProfile({ mounts: { '/repo': 'r' } }))).toBeNull()
  })
})

describe('compileProfile', () => {
  it('turns the document into session fields', () => {
    const out = compileProfile(
      parseSessionProfile({
        cwd: '/scratch',
        env: { ROLE: 'x' },
        mounts: { '/a': 'rw', '/b': 'r' },
        paths: { hide: ['/a/secrets', '*.key'] },
        vars: { hide: ['SLACK_TOKEN', 'AWS_*'] },
      }),
    )
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

  it('collects the hides of every mount section', () => {
    const out = compileProfile(
      parseSessionProfile({
        paths: { hide: ['/shared/finance'] },
        mounts: {
          '/repo': { paths: { hide: ['/repo/.env', '*.pem'] } },
          '/scratch': 'r',
        },
      }),
    )
    expect(out.hiddenPaths).toEqual({
      paths: ['/shared/finance', '/repo/.env'],
      patterns: ['*.pem'],
    })
  })

  it('of a bare or absent role states nothing', () => {
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
    // A role that names a mount without a mode narrows nothing: the
    // mount keeps whatever the workspace gave it.
    expect(compileProfile(parseSessionProfile({ mounts: { '/a': {} } })).mountModes).toBeNull()
  })
})

describe('narrow / applyProfile', () => {
  it('narrow stamps the uneditable fields, applyProfile seeds the rest', () => {
    const compiled = compileProfile(
      parseSessionProfile({
        cwd: '/a',
        env: { ROLE: 'x' },
        mounts: { '/a': 'rw' },
        paths: { hide: ['/a/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      }),
    )
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

  it("carries the role's admission rules onto the session", () => {
    const compiled = compileProfile(
      parseSessionProfile({ commands: { allow: ['ls'], ask: ['git'] } }),
    )
    expect(compiled.commands).toEqual({
      allow: ['ls'],
      ask: [{ reason: DEFAULT_ASK_REASON, commands: ['git'] }],
      deny: [],
    })
    const session = new Session({ sessionId: 's' })
    narrow(session, compiled)
    expect(session.commands).toEqual(compiled.commands)
    expect(compileProfile({ cwd: '/x' }).commands).toBeNull()
  })
})
