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
import type { Policy } from '../../../../policy/base.ts'
import type { Action, OpsContext } from '../../../../policy/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { getTestParser } from '../../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'

const DEC = new TextDecoder()

class PinLinks implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === 'unlink' && ctx.path.virtual.endsWith('.pinned')) {
      return { kind: 'deny', reason: 'pinned' }
    }
    return null
  }
}

async function makeWs(policies: Policy[] = []): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/data': new RAMResource() },
    {
      mode: MountMode.WRITE,
      policies,
      shellParserFactory: () => Promise.resolve(parser),
    },
  )
}

function err(result: { stderr: Uint8Array | null }): string {
  return result.stderr === null ? '' : DEC.decode(result.stderr)
}

describe('rm and unlink reach a link through the op door', () => {
  it('rm of a link goes through the door', async () => {
    // The strip used to write the node table directly, so a preOps
    // policy protecting a link never fired for `rm` while it fired for
    // every other door (the FUSE unlink hole, one tier up). The mount is
    // writable, so only the policy can be what refuses.
    const ws = await makeWs([new PinLinks()])
    try {
      await ws.execute('echo b > /data/f.txt')
      await ws.execute('ln -s f.txt /data/lk.pinned')
      const r = await ws.execute('rm /data/lk.pinned')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk.pinned': Permission denied\n")
      expect(ws.namespace.isLink('/data/lk.pinned')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('rm of a link on read turf names the mount', async () => {
    // The mount voice, byte for byte what `rm` of a backend file on the
    // same grant answers, because one grant must not describe itself two
    // ways depending on whether the name it stopped was a link.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const r = await ws.execute('rm /data/lk', { sessionId: 'agent' })
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe('rm: read-only mount at /data/\n')
      expect(ws.namespace.isLink('/data/lk')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('ln and mv name the mount too', async () => {
    // Same rule for the other two verbs that write the node table: `ln`
    // answers as `touch` does on a read-only mount, and `mv` as `mv` of
    // a backend file does.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const ln = await ws.execute('ln -s f.txt /data/lk2', { sessionId: 'agent' })
      const mv = await ws.execute('mv /data/lk /data/lk3', { sessionId: 'agent' })
      expect(ln.exitCode).toBe(1)
      expect(err(ln)).toBe('ln: read-only mount at /data/\n')
      expect(mv.exitCode).toBe(1)
      expect(err(mv)).toBe('mv: read-only mount at /data/\n')
      expect(ws.namespace.readlink('/data/lk')).toBe('f.txt')
    } finally {
      await ws.close()
    }
  })

  it('a refused link operand keeps the rest going', async () => {
    // GNU rm reports the operand it could not remove and removes the
    // others; the backend half of the line still runs and the exit code
    // says something failed.
    const ws = await makeWs([new PinLinks()])
    try {
      await ws.execute('echo b > /data/f.txt')
      await ws.execute('ln -s f.txt /data/lk.pinned; ln -s f.txt /data/lk')
      const r = await ws.execute('rm /data/lk.pinned /data/lk /data/f.txt')
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe("rm: cannot remove '/data/lk.pinned': Permission denied\n")
      expect(ws.namespace.isLink('/data/lk.pinned')).toBe(true)
      expect(ws.namespace.isLink('/data/lk')).toBe(false)
      const gone = await ws.execute('test -e /data/f.txt; echo $?')
      expect(DEC.decode(gone.stdout)).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('rm -f still reports a mode refusal', async () => {
    // GNU -f silences only the absent; EROFS is not ENOENT.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      const r = await ws.execute('rm -f /data/lk', { sessionId: 'agent' })
      expect(r.exitCode).toBe(1)
      expect(err(r)).toBe('rm: read-only mount at /data/\n')
    } finally {
      await ws.close()
    }
  })

  it('rm -f silences a hidden link', async () => {
    // A hidden link answers ENOENT (the no-name-leak rule), which is
    // exactly what -f silences; without -f the miss is reported.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt; ln -s f.txt /data/lk.sec')
      ws.createSession('agent', { profile: { paths: { hide: ['/data/lk.sec'] } } })
      const silent = await ws.execute('rm -f /data/lk.sec', { sessionId: 'agent' })
      const loud = await ws.execute('rm /data/lk.sec', { sessionId: 'agent' })
      expect(silent.exitCode).toBe(0)
      expect(err(silent)).toBe('')
      expect(loud.exitCode).toBe(1)
      expect(err(loud)).toBe("rm: cannot remove '/data/lk.sec': No such file or directory\n")
      expect(ws.namespace.isLink('/data/lk.sec')).toBe(true)
    } finally {
      await ws.close()
    }
  })
  it('one read-only mount speaks once', async () => {
    // The refusal names the mount, not the operand, so it is one fact
    // however many operands tripped it -- including the backend operands
    // the command tier refuses separately, whose line is the same line.
    const ws = await makeWs()
    try {
      await ws.execute('echo b > /data/f.txt')
      await ws.execute('ln -s f.txt /data/l1; ln -s f.txt /data/l2')
      ws.createSession('agent', { mounts: { '/data/': 'read' } })
      for (const line of [
        'rm /data/l1 /data/l2',
        'rm /data/l1 /data/f.txt',
        'rm /data/l1 /data/l2 /data/f.txt',
      ]) {
        const r = await ws.execute(line, { sessionId: 'agent' })
        expect(r.exitCode, line).toBe(1)
        expect(err(r), line).toBe('rm: read-only mount at /data/\n')
      }
      expect(ws.namespace.isLink('/data/l1')).toBe(true)
      expect(ws.namespace.isLink('/data/l2')).toBe(true)
    } finally {
      await ws.close()
    }
  })
})
