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

import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, PathSpec } from '../types.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { SpecPolicy } from './spec.ts'
import type { OpsContext } from './types.ts'
import type { CommandContext } from './types.ts'

function path(virtual: string, raw?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: '',
    rawPath: raw ?? virtual,
    resolved: true,
  })
}

function ctx(command: string, paths: PathSpec[]): CommandContext {
  const registry = new MountRegistry({ '/data': new RAMResource() }, MountMode.WRITE, {})
  return { command, paths, argv: [], cwd: '/', registry }
}

describe('SpecPolicy grammar', () => {
  it('a plain path denies the whole subtree and nothing beside it', () => {
    // The document's one grammar: a plain entry is an exact path and its
    // subtree, so `/data/prod` covers `/data/prod/x` but not
    // `/data/production`; the old `*`/`?`-only dialect needed
    // `/data/prod/*` and then missed the directory itself.
    const policy = new SpecPolicy({ reason: 'prod', commands: ['rm'], paths: ['/data/prod'] })
    expect(policy.preCommand(ctx('rm', [path('/data/prod')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/prod/x')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/production')]))).toBeNull()
  })

  it('a slashless glob matches any name component', () => {
    const policy = new SpecPolicy({ reason: 'keys', paths: ['*.key'] })
    expect(policy.preCommand(ctx('cat', [path('/a/b.key/c')]))).toEqual({
      kind: 'deny',
      message: 'cat: /a/b.key/c: keys\n',
      exitCode: 1,
    })
    expect(policy.preCommand(ctx('cat', [path('/a/b.keyx')]))).toBeNull()
    const op: OpsContext = { op: 'read', path: path('/x/y.key'), write: false, prefix: '/x/' }
    expect(policy.preOps(op)).toEqual({ kind: 'deny', message: 'keys\n', exitCode: 1 })
  })

  it('question mark and a class are patterns too', () => {
    const one = new SpecPolicy({ reason: 'one', paths: ['/data/?.txt'] })
    expect(one.preCommand(ctx('cat', [path('/data/a.txt')]))).not.toBeNull()
    expect(one.preCommand(ctx('cat', [path('/data/ab.txt')]))).toBeNull()
    const classed = new SpecPolicy({ reason: 'cls', paths: ['/data/[ab].txt'] })
    expect(classed.preCommand(ctx('cat', [path('/data/b.txt')]))).not.toBeNull()
    expect(classed.preCommand(ctx('cat', [path('/data/c.txt')]))).toBeNull()
  })
})

describe('SpecPolicy', () => {
  it('matches command and path, naming the operand as typed', () => {
    const policy = new SpecPolicy({
      reason: 'prod is protected',
      commands: ['rm', 'mv'],
      paths: ['/data/prod/*'],
    })
    const deny = policy.preCommand(ctx('rm', [path('/data/prod/x.txt', 'prod/x.txt')]))
    expect(deny).toEqual({
      kind: 'deny',
      message: 'rm: prod/x.txt: prod is protected\n',
      exitCode: 1,
    })
    expect(policy.preCommand(ctx('rm', [path('/data/dev/x.txt')]))).toBeNull()
    expect(policy.preCommand(ctx('cat', [path('/data/prod/x.txt')]))).toBeNull()
  })

  it('without paths refuses the command outright', () => {
    const policy = new SpecPolicy({ reason: 'not here', commands: ['shred'] })
    const deny = policy.preCommand(ctx('shred', []))
    expect(deny && 'message' in deny ? deny.message : '').toBe('shred: not here\n')
  })

  it('without commands covers every command', () => {
    const policy = new SpecPolicy({ reason: 'frozen', paths: ['/data/locked/*'] })
    expect(policy.preCommand(ctx('cat', [path('/data/locked/a')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/open/a')]))).toBeNull()
  })
})

describe('SpecPolicy preOps twin', () => {
  function opsCtx(virtual: string): OpsContext {
    return { op: 'read', path: path(virtual), write: false, prefix: '/data/' }
  }

  it('holds for path-only specs', () => {
    // Pure path protection also fires at the op door, so FUSE and
    // programmatic ops cannot bypass it.
    const policy = new SpecPolicy({ reason: 'frozen', paths: ['/data/locked/*'] })
    const deny = policy.preOps(opsCtx('/data/locked/a'))
    expect(deny && 'message' in deny ? deny.message : '').toBe('frozen\n')
    expect(policy.preOps(opsCtx('/data/open/a'))).toBeNull()
  })

  it('skips command-scoped specs', () => {
    // An op does not know which command issued it; command-scoped
    // specs stay at the command layer.
    const policy = new SpecPolicy({
      reason: 'no rm',
      commands: ['rm'],
      paths: ['/data/prod/*'],
    })
    expect(policy.preOps(opsCtx('/data/prod/x'))).toBeNull()
  })
})
