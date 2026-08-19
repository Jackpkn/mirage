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

import { seedVar } from './state.ts'
import { describe, expect, it } from 'vitest'
import type { CommandsSpec, Grant } from '../../policy/types.ts'
import { MountMode } from '../../types.ts'
import { SessionManager } from './manager.ts'
import { RAMSessionStore } from './ram.ts'

describe('SessionManager', () => {
  it('seeds the default session on construction', () => {
    const m = new SessionManager('def')
    expect(m.defaultId).toBe('def')
    expect(m.get('def').sessionId).toBe('def')
    expect(m.list()).toHaveLength(1)
  })

  it('adoptDefault re-keys the placeholder before hydration', () => {
    const m = new SessionManager('minted')
    m.get('minted').cwd = '/kept'
    m.adoptDefault('stored')
    expect(m.defaultId).toBe('stored')
    expect(m.get('stored').cwd).toBe('/kept')
    expect(m.list()).toHaveLength(1)
    expect(() => m.get('minted')).toThrow()
  })

  it('adoptDefault switches to an existing session of that id', () => {
    const m = new SessionManager('minted')
    m.create('stored')
    m.adoptDefault('stored')
    expect(m.defaultId).toBe('stored')
    expect(m.list()).toHaveLength(1)
  })

  it('exposes cwd and env for the default session', () => {
    const m = new SessionManager('def')
    m.cwd = '/data'
    m.env = { K: 'V' }
    expect(m.cwd).toBe('/data')
    expect(m.env.K).toBe('V')
    expect(m.get('def').cwd).toBe('/data')
  })

  it('create adds a new session', () => {
    const m = new SessionManager('def')
    const s = m.create('sub')
    expect(s.sessionId).toBe('sub')
    expect(
      m
        .list()
        .map((x) => x.sessionId)
        .sort(),
    ).toEqual(['def', 'sub'])
  })

  it('create throws on duplicate', () => {
    const m = new SessionManager('def')
    m.create('sub')
    expect(() => m.create('sub')).toThrow(/already exists/)
  })

  it('get throws on unknown', () => {
    const m = new SessionManager('def')
    expect(() => m.get('nope')).toThrow(/unknown session/)
  })

  it('close removes a non-default session', async () => {
    const m = new SessionManager('def')
    m.create('sub')
    await m.close('sub')
    expect(m.list().map((x) => x.sessionId)).toEqual(['def'])
  })

  it('close throws on the default session', async () => {
    const m = new SessionManager('def')
    await expect(m.close('def')).rejects.toThrow(/Cannot close the default session/)
  })

  it('closeAll keeps default but drops others', async () => {
    const m = new SessionManager('def')
    m.create('a')
    m.create('b')
    await m.closeAll()
    expect(m.list().map((x) => x.sessionId)).toEqual(['def'])
  })
})

describe('SessionManager with a SessionStore', () => {
  it('hydrates stored sessions on ensureLoaded', async () => {
    const store = new RAMSessionStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: { K: 'v' },
      created_at: 1.0,
      mount_modes: { '/data': 'read' },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const s = m.get('restored')
    expect(s.cwd).toBe('/w')
    expect(s.env).toEqual({ K: 'v', PWD: '/w' })
    expect(s.mountModes?.get('/data')).toBe(MountMode.READ)
  })

  it('locally created sessions win a hydration conflict', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/stale' })
    const m = new SessionManager('def', store)
    const local = m.create('s1')
    local.cwd = '/fresh'
    await m.ensureLoaded()
    expect(m.get('s1').cwd).toBe('/fresh')
  })

  it('default session adopts stored durable fields', async () => {
    const store = new RAMSessionStore()
    await store.set('def', { session_id: 'def', cwd: '/w', env: { A: '1' } })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    expect(m.cwd).toBe('/w')
    expect(m.env).toEqual({ A: '1', PWD: '/w' })
  })

  it('default session adopts stored hidden specs', async () => {
    // A restarted daemon must not wake up unrestricted: the stored
    // hidden shapes land on the default placeholder with the other
    // durable fields, or the first command after restart reads what
    // the spec hides and the next flush erases the restriction.
    const store = new RAMSessionStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      hidden_paths: { paths: ['/s3/secrets'], patterns: ['*.key'] },
      hidden_vars: { names: ['SLACK_TOKEN'], patterns: [] },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const dflt = m.get('def')
    expect(dflt.hiddenPaths).toEqual({ paths: ['/s3/secrets'], patterns: ['*.key'] })
    expect(dflt.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
  })

  it('defaultProfile shapes the default session and outranks a stale record', async () => {
    // A record written before the profile existed (or under an older
    // one) must not wake the primary agent unrestricted: the document
    // wins the narrowing fields after hydration, the record keeps the
    // scratch state (cwd, env), and the next flush rewrites the record.
    const store = new RAMSessionStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: { A: '1' },
      mount_modes: { '/s3': 'write', '/other': 'write' },
    })
    const m = new SessionManager('def', store)
    m.defaultProfile = {
      mountModes: new Map([['/s3', MountMode.READ]]),
      hiddenPaths: { paths: ['/s3/secrets'], patterns: [] },
      hiddenVars: { names: ['SLACK_TOKEN'], patterns: [] },
      env: { PAGER: 'cat' },
      cwd: '/s3',
      commands: null,
    }
    const dflt = m.get('def')
    expect(dflt.cwd).toBe('/s3')
    expect(dflt.env.PAGER).toBe('cat')
    expect(dflt.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    await m.ensureLoaded()
    expect(dflt.cwd).toBe('/w')
    expect(dflt.env.A).toBe('1')
    expect(dflt.mountModes).toEqual(new Map([['/s3', MountMode.READ]]))
    expect(dflt.hiddenPaths).toEqual({ paths: ['/s3/secrets'], patterns: [] })
    await m.flush()
    const stored = (await store.load()).get('def') as {
      mount_modes: Record<string, string>
      hidden_paths: { paths: string[] }
    }
    expect(stored.mount_modes).toEqual({ '/s3': 'read' })
    expect(stored.hidden_paths.paths).toEqual(['/s3/secrets'])
    // null is "no default profile", not "clear the session".
    m.defaultProfile = null
    expect(dflt.mountModes).toEqual(new Map([['/s3', MountMode.READ]]))
  })

  it('flush writes every session through', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    m.create('agent', { mountModes: new Map([['/s3', MountMode.READ]]) })
    m.cwd = '/moved'
    await m.flush()
    const entries = await store.load()
    expect(entries.get('def')?.cwd).toBe('/moved')
    expect(entries.get('agent')?.mount_modes).toEqual({ '/s3': 'read' })
  })

  it('close deletes the session from the store', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    m.create('gone')
    await m.flush()
    await m.close('gone')
    expect((await store.load()).has('gone')).toBe(false)
  })
})

class CountingStore extends RAMSessionStore {
  casCalls = 0

  override casSet(
    sessionId: string,
    fields: Parameters<RAMSessionStore['casSet']>[1],
    expectedGeneration: number,
  ): Promise<boolean> {
    this.casCalls += 1
    return super.casSet(sessionId, fields, expectedGeneration)
  }
}

describe('SessionManager dirty flush + CAS', () => {
  it('flush skips clean sessions', async () => {
    const store = new CountingStore()
    const m = new SessionManager('default', store)
    await m.flush()
    expect(store.casCalls).toBe(1)
    await m.flush()
    expect(store.casCalls).toBe(1)
    seedVar(m.get('default'), 'K', 'v')
    await m.flush()
    expect(store.casCalls).toBe(2)
  })

  it('flush bumps the generation', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('default', store)
    await m.flush()
    expect(m.get('default').generation).toBe(1)
    m.get('default').cwd = '/data'
    await m.flush()
    expect(m.get('default').generation).toBe(2)
    expect((await store.load()).get('default')?.generation).toBe(2)
  })

  it('a conflict adopts the stored generation and retries', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('default', store)
    await store.set('default', {
      session_id: 'default',
      cwd: '/theirs',
      env: {},
      generation: 5,
    })
    m.get('default').cwd = '/ours'
    await m.flush()
    const entries = await store.load()
    expect(entries.get('default')?.cwd).toBe('/ours')
    expect(entries.get('default')?.generation).toBe(6)
    expect(m.get('default').generation).toBe(6)
  })

  it('exhausted retries raise', async () => {
    class AlwaysConflict extends RAMSessionStore {
      override casSet(): Promise<boolean> {
        return Promise.resolve(false)
      }
    }
    const m = new SessionManager('default', new AlwaysConflict())
    m.get('default').cwd = '/data'
    await expect(m.flush()).rejects.toThrow(/conflict/)
  })

  it('hydrated sessions start clean', async () => {
    const store = new CountingStore()
    await store.set('s2', { session_id: 's2', cwd: '/data', env: {}, generation: 3 })
    const m = new SessionManager('default', store)
    await m.ensureLoaded()
    expect(m.get('s2').generation).toBe(3)
    const before = store.casCalls
    await m.flush()
    expect(store.casCalls).toBe(before + 1)
    seedVar(m.get('s2'), 'K', 'v')
    await m.flush()
    expect((await store.load()).get('s2')?.generation).toBe(4)
  })
})

describe('SessionManager bound hides', () => {
  it('stamps live, created and forked sessions', () => {
    const m = new SessionManager('def')
    const early = m.create('early')
    const bound = { paths: ['/shared/finance'] }
    m.boundHidden = bound
    expect(m.boundHidden).toBe(bound)
    expect(m.get('def').boundHidden).toBe(bound)
    expect(early.boundHidden).toBe(bound)
    const late = m.create('late', { mountModes: new Map([['/a', MountMode.READ]]) })
    expect(late.boundHidden).toBe(bound)
    expect(late.fork().boundHidden).toBe(bound)
    expect(late.hiddenPaths).toBeNull()
  })

  it('ride hydration but never the store', async () => {
    const store = new RAMSessionStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: {},
      created_at: 1.0,
      hidden_paths: { paths: ['/own'], patterns: [] },
    })
    const m = new SessionManager('def', store)
    const bound = { paths: ['/shared/finance'] }
    m.boundHidden = bound
    await m.ensureLoaded()
    const restored = m.get('restored')
    expect(restored.boundHidden).toBe(bound)
    expect(restored.hiddenPaths).toEqual({ paths: ['/own'], patterns: [] })
    expect(m.get('def').boundHidden).toBe(bound)
    expect('boundHidden' in restored.toJSON()).toBe(false)
    expect('bound_hidden' in restored.toJSON()).toBe(false)
    await m.flush()
    const stored = await store.load()
    expect(JSON.stringify([...stored.entries()])).not.toContain('bound')
  })
})

describe('SessionManager bound command tiers', () => {
  it('stamps live, created and forked sessions and answers commandsOf', () => {
    const m = new SessionManager('def')
    const early = m.create('early')
    const bound: CommandsSpec[] = [{ allow: ['ls', 'git'], ask: [], deny: [] }]
    m.boundCommands = bound
    expect(m.boundCommands).toBe(bound)
    expect(m.get('def').boundCommands).toBe(bound)
    expect(early.boundCommands).toBe(bound)
    const late = m.create('late')
    expect(late.boundCommands).toBe(bound)
    expect(late.fork().boundCommands).toBe(bound)
    // commandsOf: the bound tiers, then the session's own; the bound
    // tiers alone for an id the manager does not know (the empty id of
    // an unbound door included), so it still fails toward refusal.
    const own: CommandsSpec = { allow: ['ls'], ask: [], deny: [] }
    late.commands = own
    expect(m.commandsOf('late')).toEqual([...bound, own])
    expect(m.commandsOf('early')).toEqual(bound)
    expect(m.commandsOf('nobody')).toEqual(bound)
    expect(m.commandsOf('')).toEqual(bound)
  })

  it('the command tier rides the record and the bound tiers do not', async () => {
    const store = new RAMSessionStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: {},
      created_at: 1.0,
      commands: {
        allow: ['ls', 'git log'],
        ask: [],
        deny: [{ reason: 'no', commands: ['rm'], paths: [] }],
      },
    })
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      created_at: 1.0,
      commands: { allow: ['cat'], ask: [], deny: [] },
    })
    const m = new SessionManager('def', store)
    const bound: CommandsSpec[] = [
      { allow: null, ask: [], deny: [{ reason: 'ro', commands: ['git push'], mount: '/repo' }] },
    ]
    m.boundCommands = bound
    await m.ensureLoaded()
    const restored = m.get('restored')
    expect(restored.commands).toEqual({
      allow: ['ls', 'git log'],
      ask: [],
      deny: [{ reason: 'no', commands: ['rm'], paths: [], mount: '' }],
    })
    expect(restored.boundCommands).toBe(bound)
    expect(m.commandsOf('restored')).toEqual([...bound, restored.commands])
    // The default session adopts its stored tier like its hidden specs.
    expect(m.get('def').commands).toEqual({ allow: ['cat'], ask: [], deny: [] })
    expect('boundCommands' in restored.toJSON()).toBe(false)
    await m.flush()
    const stored = await store.load()
    const record = stored.get('restored') as { commands: { allow: string[] } }
    expect(record.commands.allow).toEqual(['ls', 'git log'])
    expect(JSON.stringify([...stored.entries()])).not.toContain('bound')
  })
})

describe('SessionManager host grants', () => {
  it('live on the registered session and persist', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const live = m.create('agent')
    expect(m.grantsOf('agent')).toEqual([])
    const grant: Grant = {
      decision: 'allow_session',
      rule: { reason: 'sign-off', commands: ['git push'] },
      argv: ['git', 'push'],
      cwd: '/repo',
    }
    // Written by id onto the registered session, so a fork made before
    // or after reads the same answers through the manager, whatever
    // its own copy holds; durable at the next flush.
    const fork = live.fork()
    m.setGrants('agent', [grant])
    expect(live.grants).toEqual([grant])
    expect(fork.grants).toEqual([])
    expect(m.grantsOf(fork.sessionId)).toEqual([grant])
    await m.flush()
    const stored = (await store.load()).get('agent') as { grants: { decision: string }[] }
    expect(stored.grants[0]?.decision).toBe('allow_session')
    // A manager reading that record back holds the grant.
    const again = new SessionManager('def', store)
    await again.ensureLoaded()
    expect(again.grantsOf('agent')).toEqual([
      { ...grant, rule: { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' } },
    ])
    expect(() => m.grantsOf('nobody')).toThrow(/unknown session/)
  })
})
