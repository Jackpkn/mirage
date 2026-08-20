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

import { PathSpec } from '../../types.ts'
import { Policies } from '../policies.ts'
import type { CommandContext, CommandsSpec, OpsContext } from '../types.ts'
import { PermissionsPolicy } from './permissions.ts'

const registry = { isMountRoot: () => false }

// A SessionCommandsQuery: bound tiers for every id, plus one session's
// own tier.
class Sessions {
  constructor(
    private readonly bound: readonly CommandsSpec[],
    private readonly own: Record<string, CommandsSpec>,
  ) {}

  commandsOf(sessionId: string): readonly CommandsSpec[] {
    const spec = this.own[sessionId]
    return spec === undefined ? this.bound : [...this.bound, spec]
  }
}

function path(virtual: string, raw = ''): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual,
    resolved: true,
    rawPath: raw,
  })
}

function ctx(
  command: string,
  args: string[] = [],
  extra: Partial<Omit<CommandContext, 'command' | 'registry'>> = {},
): CommandContext {
  return {
    command,
    paths: [],
    argv: args,
    cwd: '/',
    registry,
    sessionId: 's',
    tokens: [command, ...args],
    program: [command],
    ...extra,
  }
}

const BOUND: CommandsSpec[] = [
  {
    allow: null,
    ask: [],
    deny: [{ reason: 'history is read-only here', commands: ['git push'], mount: '/repo' }],
  },
  {
    allow: ['ls', 'cat', 'rm', 'git', 'python3'],
    ask: [{ reason: 'sign-off', commands: ['git push'] }],
    deny: [
      { reason: 'no deletes in the repo', commands: ['rm'], paths: ['/repo/*'] },
      { reason: 'frozen', paths: ['/repo/locked/*'] },
    ],
  },
]
const REVIEWER: CommandsSpec = { allow: ['ls', 'cat', 'git log', 'git status'], ask: [], deny: [] }

const policy = () => new PermissionsPolicy(new Sessions(BOUND, { rev: REVIEWER }))

describe('PermissionsPolicy', () => {
  it('no tiers means no opinion', () => {
    const p = new PermissionsPolicy(new Sessions([], {}))
    expect(p.preCommand(ctx('rm', ['-rf', '/']))).toBeNull()
    expect(p.preOps({ op: 'unlink', path: path('/x'), write: true, prefix: '/' })).toBeNull()
  })

  it('the allow arm refuses a visible head whose line no tier covers', () => {
    const p = policy()
    // Every tier with a list covers `ls -la` and `git log`.
    expect(p.preCommand(ctx('ls', ['-la'], { sessionId: 'rev' }))).toBeNull()
    expect(
      p.preCommand(ctx('git', ['log', '-1'], { sessionId: 'rev', program: ['git', 'log'] })),
    ).toBeNull()
    // `git` is visible in the reviewer session (some git lines are
    // allowed) but `git push` matches nothing there: a whole-command
    // refusal naming the program, not "command not found".
    expect(
      p.preCommand(ctx('git', ['push'], { sessionId: 'rev', program: ['git', 'push'] })),
    ).toEqual({ kind: 'deny', reason: 'git push is not allowed' })
    // A word that is not a tool is never refused by the allow arm.
    expect(p.preCommand(ctx('cd', ['/x'], { sessionId: 'rev', tool: false }))).toBeNull()
    // The default session runs under the bound tiers only.
    expect(p.preCommand(ctx('python3', ['-c', '1']))).toBeNull()
  })

  it('the deny arm speaks in tier order and by scope', () => {
    const p = policy()
    // Whole-command rule: reason only, the door renders `git: policy
    // denied: ...` at 126. The mount tier speaks first when it applies
    // (cwd under /repo), the workspace tier otherwise.
    expect(
      p.preCommand(ctx('git', ['push'], { cwd: '/repo/sub', program: ['git', 'push'] })),
    ).toEqual({ kind: 'deny', reason: 'history is read-only here' })
    // Off the mount, the same line falls through to the workspace tier's
    // ask rule: the deny arm ran first and had no opinion.
    expect(
      p.preCommand(ctx('git', ['push'], { cwd: '/scratch', program: ['git', 'push'] })),
    ).toEqual({
      kind: 'ask',
      reason: 'sign-off',
      rule: BOUND[1]?.ask[0],
    })
    // Operand-scoped rule: the operand as typed, in the GNU voice.
    expect(p.preCommand(ctx('rm', ['x'], { paths: [path('/repo/x', 'x')], cwd: '/repo' }))).toEqual(
      {
        kind: 'deny',
        reason: 'x: no deletes in the repo',
        scope: 'operand',
      },
    )
    expect(p.preCommand(ctx('rm', ['/scratch/x'], { paths: [path('/scratch/x')] }))).toBeNull()
    // A pure path rule refuses any command that names the path.
    expect(
      p.preCommand(ctx('cat', ['/repo/locked/a'], { paths: [path('/repo/locked/a')] })),
    ).toEqual({ kind: 'deny', reason: '/repo/locked/a: frozen', scope: 'operand' })
  })

  it('the ask arm speaks after deny, in tier order', () => {
    const p = policy()
    const askRule = BOUND[1]?.ask[0]
    // A line an ask rule covers, refused by nothing: the Ask names the
    // rule so the door can key a session grant on it.
    expect(
      p.preCommand(
        ctx('git', ['push', 'origin', 'main'], { cwd: '/scratch', program: ['git', 'push'] }),
      ),
    ).toEqual({ kind: 'ask', reason: 'sign-off', rule: askRule })
    // The deny arm runs first: on the mount the same line is refused,
    // and a grant could never re-open it because no Ask is raised.
    expect(p.preCommand(ctx('git', ['push'], { cwd: '/repo', program: ['git', 'push'] }))).toEqual({
      kind: 'deny',
      reason: 'history is read-only here',
    })
    // A session's own tier can add ask rules; the bound tiers ask first.
    const own: CommandsSpec = {
      allow: null,
      ask: [{ reason: 'rm needs a nod', commands: ['rm'] }],
      deny: [],
    }
    const scoped = new PermissionsPolicy(new Sessions(BOUND, { s: own }))
    expect(scoped.preCommand(ctx('rm', ['/scratch/x'], { paths: [path('/scratch/x')] }))).toEqual({
      kind: 'ask',
      reason: 'rm needs a nod',
      rule: own.ask[0],
    })
    // An operand-scoped ask rule asks only when the line names the path.
    const shared: CommandsSpec = {
      allow: null,
      ask: [{ reason: 'shared', commands: ['rm'], paths: ['/repo/shared/*'] }],
      deny: [],
    }
    const door = new PermissionsPolicy(new Sessions([], { s: shared }))
    expect(
      door.preCommand(ctx('rm', ['/repo/shared/a'], { paths: [path('/repo/shared/a')] })),
    ).toEqual({ kind: 'ask', reason: 'shared', rule: shared.ask[0] })
    expect(door.preCommand(ctx('rm', ['/repo/b'], { paths: [path('/repo/b')] }))).toBeNull()
  })

  it('preOps holds the pure path rules of every tier', () => {
    const p = policy()
    const locked: OpsContext = {
      op: 'write',
      path: path('/repo/locked/a'),
      write: true,
      prefix: '/repo/',
      sessionId: 's',
    }
    expect(p.preOps(locked)).toEqual({ kind: 'deny', reason: 'frozen' })
    // Command-scoped rules do not reach the op door: an op does not
    // know which command issued it.
    expect(
      p.preOps({
        op: 'unlink',
        path: path('/repo/x'),
        write: true,
        prefix: '/repo/',
        sessionId: 's',
      }),
    ).toBeNull()
    // An unbound door (empty id) still runs under the bound tiers.
    expect(
      p.preOps({ op: 'write', path: path('/repo/locked/a'), write: true, prefix: '/repo/' }),
    ).toEqual({ kind: 'deny', reason: 'frozen' })
  })

  it('seeded in a Policies chain after the builtins', async () => {
    const policies = new Policies([policy()])
    expect(
      await policies.preCommand(ctx('git', ['push'], { cwd: '/repo', program: ['git', 'push'] })),
    ).toEqual({ kind: 'deny', reason: 'history is read-only here' })
    expect(policies.wants('preOps')).toBe(true)
  })
})
