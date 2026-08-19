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
import { classifyPaths } from '../../utils/hidden.ts'
import type { CommandContext, CommandRule, OpsContext } from '../types.ts'
import { matchOp, matchRule } from './rule.ts'

const registry = { isMountRoot: () => false }

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
  extra: Partial<Omit<CommandContext, 'command' | 'registry'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', registry, ...extra }
}

describe('rules', () => {
  it('matchRule by command pattern, operand and mount', () => {
    const whole: CommandRule = { reason: 'no', commands: ['git push'] }
    expect(matchRule(whole, null, ctx('git', { tokens: ['git', 'push', 'origin'] }))).toEqual({
      operand: null,
    })
    expect(matchRule(whole, null, ctx('git', { tokens: ['git', 'pull'] }))).toBeNull()
    const scoped: CommandRule = { reason: 'no', commands: ['rm'], paths: ['/repo/*'] }
    const scope = classifyPaths(scoped.paths ?? [])
    expect(
      matchRule(scoped, scope, ctx('rm', { paths: [path('/repo/x', 'x')], cwd: '/repo' })),
    ).toEqual({ operand: 'x' })
    expect(matchRule(scoped, scope, ctx('rm', { paths: [path('/scratch/x')] }))).toBeNull()
    // A mount-tier rule applies to a line whose cwd or paths lie under
    // the mount, and to nothing else.
    const mount: CommandRule = { reason: 'ro', commands: ['git push'], mount: '/repo' }
    expect(
      matchRule(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/repo/sub' })),
    ).not.toBeNull()
    expect(
      matchRule(
        mount,
        null,
        ctx('git', { tokens: ['git', 'push'], cwd: '/scratch', paths: [path('/repo')] }),
      ),
    ).not.toBeNull()
    expect(
      matchRule(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/scratch' })),
    ).toBeNull()
    expect(
      matchRule(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/repository' })),
    ).toBeNull()
    // An every-command rule (no patterns) matches whatever line.
    expect(matchRule({ reason: 'locked' }, null, ctx('ls'))).not.toBeNull()
  })

  it('matchOp only for pure path rules', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    const op: OpsContext = {
      op: 'write',
      path: path('/data/locked/a'),
      write: true,
      prefix: '/data/',
    }
    expect(matchOp(rule, scope, op)).toBe(true)
    expect(
      matchOp(rule, scope, {
        op: 'write',
        path: path('/data/open/a'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
    const named: CommandRule = { reason: 'x', commands: ['rm'], paths: ['/data/*'] }
    expect(matchOp(named, classifyPaths(named.paths ?? []), op)).toBe(false)
    expect(matchOp({ reason: 'x', commands: ['rm'] }, null, op)).toBe(false)
  })

  function subtreeCtx(command: string, ...operands: string[]): CommandContext {
    const paths = operands.map((o) => path(o, o))
    return ctx(command, { paths, operands: paths, argv: operands, tokens: [command, ...operands] })
  }

  it('a subtree command on the directory holding the scope matches', () => {
    // `/x/locked/*` protects the children; `rm -r /x/locked`, `rm -r /x`
    // and `mv /x/locked elsewhere` take them along, so for rm, rmdir and
    // mv the operand at or above the holding directory matches.
    const rule: CommandRule = { reason: 'frozen', paths: ['/x/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    for (const command of ['rm', 'rmdir']) {
      for (const operand of ['/x/locked', '/x', '/']) {
        expect(matchRule(rule, scope, subtreeCtx(command, operand))).toEqual({ operand })
      }
      expect(matchRule(rule, scope, subtreeCtx(command, '/x/other'))).toBeNull()
    }
    expect(matchRule(rule, scope, subtreeCtx('mv', '/x/locked', '/y'))).toEqual({
      operand: '/x/locked',
    })
    expect(matchRule(rule, scope, subtreeCtx('mv', '/x', '/y'))).toEqual({ operand: '/x' })
    // mv's destination matches only as the holding directory itself:
    // moving into it lands in the scope, moving into an ancestor does not.
    expect(matchRule(rule, scope, subtreeCtx('mv', '/z', '/x/locked'))).toEqual({
      operand: '/x/locked',
    })
    expect(matchRule(rule, scope, subtreeCtx('mv', '/z', '/x'))).toBeNull()
    // A reader given the same operand is not a whole-line refusal: its
    // I/O under the scope is the command tier's to refuse, file by file.
    expect(matchRule(rule, scope, subtreeCtx('cat', '/x/locked'))).toBeNull()
    expect(matchRule(rule, scope, subtreeCtx('cp', '/x', '/y'))).toBeNull()
    // A command-scoped rule judges its own command the same way.
    const named: CommandRule = { reason: 'locked', commands: ['rm'], paths: ['/x/locked/*'] }
    const namedScope = classifyPaths(named.paths ?? [])
    expect(matchRule(named, namedScope, subtreeCtx('rm', '/x'))).toEqual({ operand: '/x' })
    expect(matchRule(named, namedScope, subtreeCtx('mv', '/x', '/y'))).toBeNull()
  })

  it('matchOp refuses a subtree op on the directory holding the scope', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    for (const [op, virtual] of [
      ['rename', '/data/locked'],
      ['rename', '/data'],
      ['rmdir', '/data/locked'],
      ['rm_r', '/data'],
    ] as const) {
      expect(matchOp(rule, scope, { op, path: path(virtual), write: true, prefix: '/data/' })).toBe(
        true,
      )
    }
    // A read or write of the directory itself is not in the scope, and a
    // subtree op beside the scope is not either.
    expect(
      matchOp(rule, scope, {
        op: 'readdir',
        path: path('/data/locked'),
        write: false,
        prefix: '/data/',
      }),
    ).toBe(false)
    expect(
      matchOp(rule, scope, {
        op: 'rename',
        path: path('/data/other'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
  })
})
