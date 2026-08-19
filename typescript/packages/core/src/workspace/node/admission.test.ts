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

import { afterEach, describe, expect, it } from 'vitest'

import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { admit, admitLine, policyScopes } from './admission.ts'

const DEC = new TextDecoder()

const DOC = {
  commands: {
    allow: ['cat', 'rm', 'ls', 'ln', 'echo', 'head'],
    deny: [{ reason: 'sealed', commands: ['cat'], paths: ['/data/secret*'] }],
  },
  paths: { hide: [] },
}

const open: Workspace[] = []
afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function ws(): Promise<Workspace> {
  const parser = await getTestParser()
  const w = new Workspace(
    { '/data': new RAMResource() },
    { mode: MountMode.WRITE, shellParser: parser, permissions: DOC },
  )
  open.push(w)
  return w
}

function virtuals(w: Workspace, name: string, ...args: string[]): string[] {
  const words = classifyParts([name, ...args], w.registry, '/')
  return policyScopes(name, args, words.slice(1), w.namespace, '/').map((p) => p.virtual)
}

describe('admission', () => {
  it('policy scopes follow links only for a following command', async () => {
    const w = await ws()
    await w.execute('echo top > /data/secret && ln -s /data/secret /data/link')
    // cat opens the target: the typed path first, then what it resolves
    // to; rm and `ls -l` act on the link itself.
    expect(virtuals(w, 'cat', '/data/link')).toEqual(['/data/link', '/data/secret'])
    expect(virtuals(w, 'rm', '/data/link')).toEqual(['/data/link'])
    expect(virtuals(w, 'ls', '-l', '/data/link')).toEqual(['/data/link'])
    expect(virtuals(w, 'ls', '/data/link')).toEqual(['/data/link', '/data/secret'])
    // A path that is not a link reads once; no namespace reads typed.
    expect(virtuals(w, 'cat', '/data/secret')).toEqual(['/data/secret'])
    const words = classifyParts(['cat', '/data/link'], w.registry, '/')
    expect(
      policyScopes('cat', ['/data/link'], words.slice(1), null, '/').map((p) => p.virtual),
    ).toEqual(['/data/link'])
  })

  it('admitLine refuses the first offending command', async () => {
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = (text: string) => admitLine(parser.parse(text), session, w.registry, w.namespace)
    expect(await line('cat /data/a | head -n 1')).toBeNull()
    // An unlisted word anywhere in the line is 127 before any hook.
    const unlisted = await line('cat /data/a | sort')
    expect(unlisted).not.toBeNull()
    expect([unlisted?.exitCode, DEC.decode(unlisted?.stderr)]).toEqual([
      127,
      'sort: command not found\n',
    ])
    // A rule reads the literal words, path-shaped ones as paths.
    const sealed = await line('ls /data && cat /data/secret')
    expect([sealed?.exitCode, DEC.decode(sealed?.stderr)]).toEqual([
      1,
      'cat: /data/secret: sealed\n',
    ])
    // The same gate, one command at a time.
    expect(await admit('rm', ['/data/x'], [], session, w.registry, w.namespace)).toBeNull()
  })
})
