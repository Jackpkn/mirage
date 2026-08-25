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

import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountBackend, MountMode } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from './workspace.ts'

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(),
  runMount: vi.fn(),
  runUmount: vi.fn(),
  prepareMountpoint: vi.fn(),
  stop: vi.fn(),
  flushAll: vi.fn(),
}))

vi.mock('./nfs/mount.ts', () => ({
  startServer: mocks.startServer,
  runMount: mocks.runMount,
  runUmount: mocks.runUmount,
  prepareMountpoint: mocks.prepareMountpoint,
}))

const PORT = 20490

function nfsWorkspace(mountpoint?: string): Workspace {
  return new Workspace(
    {
      '/data': new Mount(new RAMResource(), {
        backend: MountBackend.NFS,
        ...(mountpoint !== undefined ? { mountpoint } : {}),
      }),
    },
    { mode: MountMode.WRITE },
  )
}

describe('Workspace nfs backend (without a real kernel mount)', () => {
  beforeEach(() => {
    let unnamed = 0
    mocks.startServer.mockReset()
    mocks.runMount.mockReset()
    mocks.runUmount.mockReset()
    mocks.prepareMountpoint.mockReset()
    mocks.stop.mockReset()
    mocks.flushAll.mockReset()

    mocks.prepareMountpoint.mockImplementation((mountpoint?: string) => {
      if (mountpoint !== undefined) return [mountpoint, false]
      unnamed += 1
      return [`/tmp/fake-nfs-${String(unnamed)}`, true]
    })
    mocks.flushAll.mockImplementation(() => Promise.resolve())
    mocks.startServer.mockImplementation(() =>
      Promise.resolve([{ flushAll: mocks.flushAll }, { port: () => PORT, stop: mocks.stop }]),
    )
    mocks.runMount.mockImplementation(() => Promise.resolve())
    mocks.runUmount.mockImplementation(() => Promise.resolve())
  })

  it('mounts a declared nfs Mount and reports it as an nfs mountpoint', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()

    expect(ws.nfsMountpoints).toEqual({ '/data': '/tmp/pinned-data' })
    // The mount options ride on the config, so the mount is asserted
    // with it: a mountpoint mounted without it is a hard mount, which is
    // the one that wedges the host when the server stops.
    expect(mocks.runMount).toHaveBeenCalledWith(
      '/tmp/pinned-data',
      PORT,
      '/data',
      expect.objectContaining({ soft: true }),
    )

    await ws.close()
  })

  it('keeps nfs mounts out of the fuse view', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()

    expect(ws.fuseMountpoints).toEqual({})
    expect(ws.fuseMountpoint).toBeNull()

    await ws.close()
  })

  it('mounts the declaration on the first execute', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.execute('echo hi > /data/x.txt')

    expect(ws.nfsMountpoints).toEqual({ '/data': '/tmp/pinned-data' })

    await ws.close()
  })

  it('backs every prefix with one server', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    const second = await ws.addNfsMount('/data/sub', '/tmp/pinned-sub')

    expect(second).toBe('/tmp/pinned-sub')
    expect(mocks.startServer).toHaveBeenCalledTimes(1)
    expect(Object.keys(ws.nfsMountpoints).sort()).toEqual(['/data', '/data/sub'])

    await ws.close()
  })

  it('unmounts one prefix without stopping the server', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    await ws.removeNfsMount('/data')

    expect(ws.nfsMountpoints).toEqual({})
    expect(mocks.runUmount).toHaveBeenCalledWith('/tmp/pinned-data')
    expect(mocks.stop).not.toHaveBeenCalled()

    await ws.close()
  })

  it('flushes and stops the server on close', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    await ws.close()

    expect(mocks.runUmount).toHaveBeenCalledWith('/tmp/pinned-data')
    expect(mocks.flushAll).toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalled()
    expect(ws.nfsMountpoints).toEqual({})
  })

  it('refuses a session-bound nfs mount', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    const session = ws.createSession('bound')

    await expect(
      ws.addFuseMount('/data', undefined, session.sessionId, MountBackend.NFS),
    ).rejects.toThrow(/session-bound/)

    await ws.close()
  })

  it('refuses a mountpoint another prefix already serves', async () => {
    const ws = nfsWorkspace('/tmp/shared')
    await ws.nfsReady()

    await expect(ws.addNfsMount('/data/sub', '/tmp/shared')).rejects.toThrow(/already used/)

    await ws.close()
  })
})
