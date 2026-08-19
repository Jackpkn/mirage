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

import { PathSpec } from '../types.ts'
import { Approvals, askRule } from './approvals.ts'
import { CallbackApprover, requestId } from './approver.ts'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Ask,
  CommandContext,
  CommandRule,
  Grant,
  Pending,
} from './types.ts'

const RULE: CommandRule = { reason: 'sign-off', commands: ['git push'] }
const ASK: Ask = { kind: 'ask', reason: 'sign-off', rule: RULE }
const registry = { isMountRoot: () => false }

/** A SessionGrantsQuery over a map, counting flushes. */
class Sessions {
  readonly grants = new Map<string, readonly Grant[]>()
  flushes = 0

  grantsOf(sessionId: string): readonly Grant[] {
    return this.grants.get(sessionId) ?? []
  }

  setGrants(sessionId: string, grants: readonly Grant[]): void {
    this.grants.set(sessionId, grants)
  }

  flush(): Promise<void> {
    this.flushes += 1
    return Promise.resolve()
  }
}

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual,
    resolved: true,
    rawPath: virtual,
  })
}

function ctx(
  words: readonly string[] = ['git', 'push'],
  extra: {
    cwd?: string
    sessionId?: string
    program?: readonly string[]
    paths?: PathSpec[]
    agentId?: string
  } = {},
): CommandContext {
  return {
    command: words[0] ?? '',
    paths: extra.paths ?? [],
    argv: words.slice(1),
    cwd: extra.cwd ?? '/repo',
    registry,
    sessionId: extra.sessionId ?? 's',
    agentId: extra.agentId ?? '',
    tokens: words,
    program: extra.program ?? ['git', 'push'],
  }
}

const allowOnce = (_r: ApprovalRequest): Promise<ApprovalDecision> => Promise.resolve('allow_once')
const allowSession = (_r: ApprovalRequest): Promise<ApprovalDecision> =>
  Promise.resolve('allow_session')
const denyIt = (_r: ApprovalRequest): Promise<ApprovalDecision> => Promise.resolve('deny')

describe('askRule', () => {
  it("is the document's or the program that asked", () => {
    expect(askRule(ctx(), ASK)).toBe(RULE)
    expect(
      askRule(ctx(['git', '-C', '/r', 'push'], { program: ['git', 'push'] }), {
        kind: 'ask',
        reason: 'looks risky',
      }),
    ).toEqual({ reason: 'looks risky', commands: ['git push'] })
    expect(
      askRule(ctx(['rm', '-rf', 'x'], { program: [] }), { kind: 'ask', reason: 'risky' }),
    ).toEqual({
      reason: 'risky',
      commands: ['rm'],
    })
  })
})

describe('Approvals', () => {
  it('record flow: once', async () => {
    const sessions = new Sessions()
    const door = new Approvals(sessions)
    const line = ctx(['git', 'push'], { paths: [path('/repo')] })
    // Asked: pending, quoting an id the host can act on; the request
    // carries what was asked.
    const pending = (await door.resolve(line, ASK)) as Pending
    expect(pending).toEqual({
      kind: 'pending',
      id: await requestId('s', '/repo', ['git', 'push']),
      reason: 'sign-off',
    })
    expect(door.list()).toEqual([
      {
        id: pending.id,
        sessionId: 's',
        agentId: '',
        command: 'git',
        argv: ['push'],
        cwd: '/repo',
        paths: ['/repo'],
        reason: 'sign-off',
        rule: RULE,
      },
    ])
    // A retry asks the same question: no second entry, same id.
    expect(await door.resolve(line, ASK)).toEqual(pending)
    expect(door.list()).toHaveLength(1)
    // Granted once: the exact line passes one time, durably, and is
    // then asked again.
    await door.grant(pending.id)
    expect(door.list()).toEqual([])
    expect(sessions.flushes).toBe(1)
    expect(sessions.grants.get('s')).toEqual([
      { decision: 'allow_once', rule: RULE, argv: ['git', 'push'], cwd: '/repo' },
    ])
    expect(await door.resolve(line, ASK)).toBeNull()
    expect(sessions.grants.get('s')).toEqual([])
    expect(await door.resolve(line, ASK)).toEqual(pending)
    // A once grant is for the exact words and cwd: a different line
    // under the same rule is asked, and so is the same line elsewhere.
    await door.grant(pending.id)
    expect((await door.resolve(ctx(['git', 'push', '--force']), ASK))?.kind).toBe('pending')
    expect((await door.resolve(ctx(['git', 'push'], { cwd: '/scratch' }), ASK))?.kind).toBe(
      'pending',
    )
    expect(await door.resolve(line, ASK)).toBeNull()
  })

  it('record flow: session and deny', async () => {
    const sessions = new Sessions()
    const door = new Approvals(sessions)
    const pending = (await door.resolve(ctx(), ASK)) as Pending
    expect(pending.kind).toBe('pending')
    // Granted for the session: every line the rule covers passes, the
    // grant stays; another session is not covered.
    await door.grant(pending.id, 'session')
    expect(await door.resolve(ctx(), ASK)).toBeNull()
    expect(await door.resolve(ctx(['git', 'push', '--force']), ASK)).toBeNull()
    expect(await door.resolve(ctx(['git', 'push'], { cwd: '/scratch' }), ASK)).toBeNull()
    expect(sessions.grants.get('s')).toEqual([
      { decision: 'allow_session', rule: RULE, argv: ['git', 'push'], cwd: '/repo' },
    ])
    const other = (await door.resolve(ctx(['git', 'push'], { sessionId: 't' }), ASK)) as Pending
    expect(other.kind).toBe('pending')
    // A different rule is a different question even for the same line.
    const force: Ask = {
      kind: 'ask',
      reason: 'force needs a second pair of eyes',
      rule: { reason: 'force needs a second pair of eyes', commands: ['git push --force'] },
    }
    expect((await door.resolve(ctx(['git', 'push', '--force']), force))?.kind).toBe('pending')
    // Denied: the retry of the exact line is refused once, in the ask's
    // voice, then the question is open again.
    await door.deny(other.id)
    expect(await door.resolve(ctx(['git', 'push'], { sessionId: 't' }), ASK)).toEqual({
      kind: 'deny',
      reason: 'sign-off',
    })
    expect((await door.resolve(ctx(['git', 'push'], { sessionId: 't' }), ASK))?.kind).toBe(
      'pending',
    )
  })

  it('unknown or answered ids are refused', async () => {
    const door = new Approvals(new Sessions())
    await expect(door.grant('nothing')).rejects.toThrow(/no pending approval/)
    const pending = (await door.resolve(ctx(), ASK)) as Pending
    await door.deny(pending.id)
    await expect(door.deny(pending.id)).rejects.toThrow(/no pending approval/)
    // A blocking approver leaves nothing to grant.
    const blocking = new Approvals(new Sessions(), new CallbackApprover(allowOnce))
    expect(blocking.list()).toEqual([])
    await expect(blocking.grant('x')).rejects.toThrow(/no pending approval/)
  })

  it('callback flow answers inside the line', async () => {
    const sessions = new Sessions()
    const once = new Approvals(sessions, new CallbackApprover(allowOnce))
    expect(await once.resolve(ctx(), ASK)).toBeNull()
    expect(sessions.grants.size).toBe(0)
    const forever = new Approvals(sessions, new CallbackApprover(allowSession))
    expect(await forever.resolve(ctx(), ASK)).toBeNull()
    expect(sessions.grants.get('s')).toEqual([
      { decision: 'allow_session', rule: RULE, argv: ['git', 'push'], cwd: '/repo' },
    ])
    const no = new Approvals(new Sessions(), new CallbackApprover(denyIt))
    expect(await no.resolve(ctx(), ASK)).toEqual({ kind: 'deny', reason: 'sign-off' })
  })

  it('a coded ask keys the session grant on the program', async () => {
    const sessions = new Sessions()
    const door = new Approvals(sessions, new CallbackApprover(allowSession))
    const coded: Ask = { kind: 'ask', reason: 'looks risky' }
    expect(await door.resolve(ctx(['rm', '-rf', 'x'], { program: ['rm'] }), coded)).toBeNull()
    // The next rm line under the same coded ask is covered ...
    const recorder = new Approvals(sessions)
    expect(await recorder.resolve(ctx(['rm', 'y'], { program: ['rm'] }), coded)).toBeNull()
    // ... a different program is not.
    expect((await recorder.resolve(ctx(['mv', 'a', 'b'], { program: ['mv'] }), coded))?.kind).toBe(
      'pending',
    )
  })

  it('without sessions, grants live in memory', async () => {
    const door = new Approvals()
    // The request names the agent the line carries, not one the door
    // was configured with: a nested or concurrent line keeps its own.
    const pending = (await door.resolve(
      ctx(['git', 'push'], { agentId: 'claude' }),
      ASK,
    )) as Pending
    expect(pending.kind).toBe('pending')
    expect(door.list()[0]?.agentId).toBe('claude')
    await door.grant(pending.id, 'session')
    expect(await door.resolve(ctx(), ASK)).toBeNull()
    expect((await door.resolve(ctx(['git', 'push'], { sessionId: 't' }), ASK))?.kind).toBe(
      'pending',
    )
  })
})
