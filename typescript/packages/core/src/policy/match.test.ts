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
import { classifyPaths } from '../utils/hidden.ts'
import {
  WILDCARD,
  headVisible,
  intersectPatterns,
  lineAllowed,
  lineTokens,
  opHit,
  patternMatches,
  patternNames,
  ruleHit,
  splitPattern,
} from './match.ts'
import type { CommandContext, CommandRule, CommandsSpec, OpsContext } from './types.ts'

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

describe('patterns', () => {
  it('splitPattern drops trailing wildcards only', () => {
    expect(splitPattern('git push')).toEqual(['git', 'push'])
    expect(splitPattern('git *')).toEqual(['git'])
    expect(splitPattern('git * *')).toEqual(['git'])
    expect(splitPattern('git * --hard')).toEqual(['git', WILDCARD, '--hard'])
    expect(splitPattern('  rm  ')).toEqual(['rm'])
    expect(splitPattern('*')).toEqual([])
  })

  it('patternMatches is a token prefix', () => {
    expect(patternMatches('rm', ['rm', '-rf', '/x'])).toBe(true)
    expect(patternMatches('rm', ['rm'])).toBe(true)
    expect(patternMatches('rm', ['rmdir'])).toBe(false)
    expect(patternMatches('git push', ['git', 'push', 'origin', 'main'])).toBe(true)
    expect(patternMatches('git push', ['git', 'pull'])).toBe(false)
    expect(patternMatches('git push', ['git'])).toBe(false)
    expect(patternMatches('git reset --hard', ['git', 'reset', '--hard', 'HEAD'])).toBe(true)
    expect(patternMatches('git reset --hard', ['git', 'reset', 'HEAD', '--hard'])).toBe(false)
    // A wildcard token is any one token; trailing it is redundant.
    expect(patternMatches('git * --hard', ['git', 'reset', '--hard'])).toBe(true)
    expect(patternMatches('git * --hard', ['git', 'reset', '--soft'])).toBe(false)
    expect(patternMatches('git *', ['git'])).toBe(true)
    expect(patternMatches('*', ['anything', 'at', 'all'])).toBe(true)
  })

  it('patternNames and headVisible', () => {
    expect(patternNames('git log', 'git')).toBe(true)
    expect(patternNames('git log', 'log')).toBe(false)
    expect(patternNames('*', 'rm')).toBe(true)
    const layers: CommandsSpec[] = [
      { allow: ['ls', 'git'], ask: [], deny: [] },
      { allow: ['ls', 'cat', 'git log'], ask: [], deny: [] },
    ]
    // A name must start a pattern of every tier that has a list.
    expect(headVisible('ls', layers)).toBe(true)
    expect(headVisible('git', layers)).toBe(true)
    expect(headVisible('cat', layers)).toBe(false)
    expect(headVisible('rm', layers)).toBe(false)
    // A tier without a list hides nothing; no tiers hide nothing.
    expect(headVisible('rm', [{ allow: null, ask: [], deny: [{ reason: 'x' }] }])).toBe(true)
    expect(headVisible('rm', [])).toBe(true)
  })

  it('lineAllowed intersects the tiers and skips non-tools', () => {
    const layers: CommandsSpec[] = [
      { allow: ['ls', 'git'], ask: [], deny: [] },
      { allow: ['ls', 'git log', 'git status'], ask: [], deny: [] },
    ]
    expect(lineAllowed(ctx('ls', { argv: ['-la'], tokens: ['ls', '-la'] }), layers)).toBe(true)
    expect(lineAllowed(ctx('git', { tokens: ['git', 'log', '-1'] }), layers)).toBe(true)
    // The head is visible (some git line is allowed) but this line is
    // covered by no pattern of the second tier.
    expect(lineAllowed(ctx('git', { tokens: ['git', 'push'] }), layers)).toBe(false)
    // A word that is not a tool is never refused by an allow list.
    expect(lineAllowed(ctx('cd', { tokens: ['cd', '/x'], tool: false }), layers)).toBe(true)
    // A context built without the door's tokens reads the raw argv.
    const raw = ctx('git', { argv: ['push'] })
    expect(lineTokens(raw)).toEqual(['git', 'push'])
    expect(lineAllowed(raw, layers)).toBe(false)
  })

  it('intersectPatterns unifies token by token', () => {
    expect(intersectPatterns(['git'], ['git log', 'git diff'])).toEqual(['git log', 'git diff'])
    expect(intersectPatterns(['ls', 'cat', 'git'], ['cat', 'git log'])).toEqual(['cat', 'git log'])
    expect(intersectPatterns(['*'], ['ls'])).toEqual(['ls'])
    expect(intersectPatterns(['git * --hard'], ['git reset'])).toEqual(['git reset --hard'])
    expect(intersectPatterns(['rm'], ['ls'])).toEqual([])
    expect(intersectPatterns(['*'], ['*'])).toEqual(['*'])
    // Duplicates collapse, order follows the first list.
    expect(intersectPatterns(['git', 'git log'], ['git log'])).toEqual(['git log'])
  })
})

describe('rules', () => {
  it('ruleHit by command pattern, operand and mount', () => {
    const whole: CommandRule = { reason: 'no', commands: ['git push'] }
    expect(ruleHit(whole, null, ctx('git', { tokens: ['git', 'push', 'origin'] }))).toEqual({
      operand: null,
    })
    expect(ruleHit(whole, null, ctx('git', { tokens: ['git', 'pull'] }))).toBeNull()
    const scoped: CommandRule = { reason: 'no', commands: ['rm'], paths: ['/repo/*'] }
    const scope = classifyPaths(scoped.paths ?? [])
    expect(
      ruleHit(scoped, scope, ctx('rm', { paths: [path('/repo/x', 'x')], cwd: '/repo' })),
    ).toEqual({ operand: 'x' })
    expect(ruleHit(scoped, scope, ctx('rm', { paths: [path('/scratch/x')] }))).toBeNull()
    // A mount-tier rule applies to a line whose cwd or paths lie under
    // the mount, and to nothing else.
    const mount: CommandRule = { reason: 'ro', commands: ['git push'], mount: '/repo' }
    expect(
      ruleHit(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/repo/sub' })),
    ).not.toBeNull()
    expect(
      ruleHit(
        mount,
        null,
        ctx('git', { tokens: ['git', 'push'], cwd: '/scratch', paths: [path('/repo')] }),
      ),
    ).not.toBeNull()
    expect(
      ruleHit(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/scratch' })),
    ).toBeNull()
    expect(
      ruleHit(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/repository' })),
    ).toBeNull()
    // An every-command rule (no patterns) hits whatever line.
    expect(ruleHit({ reason: 'locked' }, null, ctx('ls'))).not.toBeNull()
  })

  it('opHit only for pure path rules', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    const op: OpsContext = {
      op: 'write',
      path: path('/data/locked/a'),
      write: true,
      prefix: '/data/',
    }
    expect(opHit(rule, scope, op)).toBe(true)
    expect(
      opHit(rule, scope, {
        op: 'write',
        path: path('/data/open/a'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
    const named: CommandRule = { reason: 'x', commands: ['rm'], paths: ['/data/*'] }
    expect(opHit(named, classifyPaths(named.paths ?? []), op)).toBe(false)
    expect(opHit({ reason: 'x', commands: ['rm'] }, null, op)).toBe(false)
  })
})
