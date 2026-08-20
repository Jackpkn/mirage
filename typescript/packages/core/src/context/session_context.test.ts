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
import {
  effectiveMountMode,
  getAdmission,
  getCurrentSession,
  getCurrentSessionFor,
  hiddenPathsActive,
  pathAllowed,
  pathRulesActive,
  runWithAdmission,
  runWithSession,
  sessionPathAllowed,
} from './session_context.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import { MountMode, weakerMode } from '../types.ts'
import { SessionManager } from '../workspace/session/manager.ts'
import { Session } from '../workspace/session/session.ts'

function narrowedSession(): Session {
  return new Session({
    sessionId: 'agent',
    mountModes: new Map([
      ['/ro', MountMode.READ],
      ['/rw', MountMode.WRITE],
      ['/ex', MountMode.EXEC],
    ]),
  })
}

describe('weakerMode', () => {
  it('follows the READ < WRITE < EXEC lattice', () => {
    expect(weakerMode(MountMode.READ, MountMode.WRITE)).toBe(MountMode.READ)
    expect(weakerMode(MountMode.WRITE, MountMode.READ)).toBe(MountMode.READ)
    expect(weakerMode(MountMode.EXEC, MountMode.WRITE)).toBe(MountMode.WRITE)
    expect(weakerMode(MountMode.EXEC, MountMode.EXEC)).toBe(MountMode.EXEC)
  })
})

describe('a role narrows the mounts it names', () => {
  it('no bound session is unrestricted', () => {
    expect(effectiveMountMode('/anything', MountMode.WRITE)).toBe(MountMode.WRITE)
  })

  it('a role naming no mount keeps every mode', async () => {
    await runWithSession(new Session({ sessionId: 'free' }), () => {
      expect(effectiveMountMode('/s3', MountMode.EXEC)).toBe(MountMode.EXEC)
      return Promise.resolve()
    })
  })

  it('narrows the mount mode', async () => {
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/ro', MountMode.WRITE)).toBe(MountMode.READ)
      expect(effectiveMountMode('/rw', MountMode.EXEC)).toBe(MountMode.WRITE)
      return Promise.resolve()
    })
  })

  it('cannot widen the mount mode', async () => {
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/ex', MountMode.READ)).toBe(MountMode.READ)
      expect(effectiveMountMode('/rw', MountMode.READ)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('normalizes prefixes before lookup', async () => {
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/ro/', MountMode.WRITE)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('a mount the role does not name keeps its own mode', async () => {
    // Naming three mounts is not an allowlist: a fourth is reachable at
    // whatever the workspace gave it. A role that must not touch a
    // mount hides it, which reads as ENOENT rather than as a permission
    // error naming something the role cannot see.
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/other', MountMode.EXEC)).toBe(MountMode.EXEC)
      expect(effectiveMountMode('/', MountMode.WRITE)).toBe(MountMode.WRITE)
      return Promise.resolve()
    })
  })
})

describe('a binding belongs to the workspace that published it', () => {
  it('answers only its own manager', async () => {
    const mine = new SessionManager('default')
    const theirs = new SessionManager('default')
    const session = new Session({ sessionId: 'default' })
    await runWithSession(
      session,
      () => {
        expect(getCurrentSessionFor(mine)).toBe(session)
        expect(getCurrentSessionFor(theirs)).toBeNull()
        expect(getCurrentSession()).toBe(session)
        return Promise.resolve()
      },
      mine,
    )
  })

  it('a nested bind keeps the owner', async () => {
    // A background job's fork is still the workspace's own session.
    const mine = new SessionManager('default')
    const outer = new Session({ sessionId: 'default' })
    const inner = new Session({ sessionId: 'default' })
    await runWithSession(
      outer,
      () =>
        runWithSession(inner, () => {
          expect(getCurrentSessionFor(mine)).toBe(inner)
          return Promise.resolve()
        }),
      mine,
    )
  })

  it('an unowned bind answers nobody', async () => {
    // The op-dispatch binders name no owner, so no line adopts one.
    await runWithSession(new Session({ sessionId: 'default' }), () => {
      expect(getCurrentSessionFor(new SessionManager('default'))).toBeNull()
      return Promise.resolve()
    })
  })

  it('node isolates concurrent tasks', () => {
    // What lets a background job bind its fork without the foreground
    // seeing it; the browser fallback storage cannot, and jobs.ts
    // reads this to decide.
    expect(asyncContextIsolatesTasks).toBe(true)
  })
})

describe('hides', () => {
  it("a role's hides reach the predicate as paths and patterns", async () => {
    // One list per session, built by the compiler from the role's own
    // `paths.hide` and every mount section's, exact entries and glob
    // patterns told apart once by `classifyPaths`.
    const sess = new Session({
      sessionId: 'agent',
      hiddenPaths: {
        paths: ['/a/secrets', '/shared/finance'],
        patterns: ['/repo/*.pem'],
      },
    })
    await runWithSession(sess, () => {
      expect(hiddenPathsActive()).toBe(true)
      expect(pathAllowed('/a/secrets/x')).toBe(false)
      expect(pathAllowed('/shared/finance/q1.csv')).toBe(false)
      expect(pathAllowed('/repo/certs/k.pem')).toBe(false)
      expect(pathAllowed('/repo/README')).toBe(true)
      expect(pathAllowed('/shared/public')).toBe(true)
      return Promise.resolve()
    })
  })

  it('the explicit-session predicate answers without a binding', async () => {
    // A door that holds the session (the admission gate) asks it
    // directly; the bound form is the same answer for the bound
    // session, and no session bound means nothing is hidden.
    const sess = new Session({
      sessionId: 'agent',
      hiddenPaths: { paths: ['/a/secrets'], patterns: ['*.pem'] },
    })
    expect(getCurrentSession()).toBeNull()
    expect(sessionPathAllowed(sess, '/a/secrets/x')).toBe(false)
    expect(sessionPathAllowed(sess, '/repo/k.pem')).toBe(false)
    expect(sessionPathAllowed(sess, '/a/public')).toBe(true)
    expect(pathAllowed('/a/secrets/x')).toBe(true)
    await runWithSession(sess, () => {
      expect(pathAllowed('/a/secrets/x')).toBe(false)
      expect(pathAllowed('/a/public')).toBe(true)
      return Promise.resolve()
    })
  })

  it('a hide activates the gate and a role without one does not', async () => {
    const sess = new Session({ sessionId: 'agent', hiddenPaths: { paths: ['/repo/.env'] } })
    await runWithSession(sess, () => {
      expect(hiddenPathsActive()).toBe(true)
      expect(pathAllowed('/repo/.env')).toBe(false)
      expect(pathAllowed('/repo/.envrc')).toBe(true)
      return Promise.resolve()
    })
    await runWithSession(new Session({ sessionId: 'free' }), () => {
      expect(hiddenPathsActive()).toBe(false)
      expect(pathAllowed('/repo/.env')).toBe(true)
      return Promise.resolve()
    })
  })
})

describe('the admission binding', () => {
  it('is scoped to one command and hands the outer one back', async () => {
    const gate = (scoped: boolean) => ({ scoped, check: () => undefined })
    expect(getAdmission()).toBeNull()
    expect(pathRulesActive()).toBe(false)
    const outer = gate(true)
    await runWithAdmission(outer, async () => {
      expect(getAdmission()).toBe(outer)
      expect(pathRulesActive()).toBe(true)
      // A nested line binds its own and hands the outer one back.
      const inner = gate(false)
      await runWithAdmission(inner, () => {
        expect(getAdmission()).toBe(inner)
        expect(pathRulesActive()).toBe(false)
        return Promise.resolve()
      })
      expect(getAdmission()).toBe(outer)
    })
    expect(getAdmission()).toBeNull()
    expect(pathRulesActive()).toBe(false)
  })
})
