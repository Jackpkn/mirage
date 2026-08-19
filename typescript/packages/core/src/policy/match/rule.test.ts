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
})
