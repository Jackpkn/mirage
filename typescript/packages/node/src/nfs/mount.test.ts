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

import { existsSync, mkdtempSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { EINVAL, ENOENT } from '../fuse/errors.ts'
import { ESTALE_WIRE, RenameIntoSelfError, StaleHandleError } from './errors.ts'
import {
  ADDON_ENV,
  ADDON_PACKAGE,
  awaitIsMount,
  buildDelegate,
  isMountPoint,
  loadAddon,
  mountArgs,
  prepareMountpoint,
  umountArgs,
} from './mount.ts'
import type { NFSDelegateTarget } from './mount.ts'
import type { DirEntry, NFSAttrs } from './types.ts'

const ATTRS: NFSAttrs = { fileid: 7, size: 3, isDir: false, isSymlink: false }

function target(overrides: Partial<NFSDelegateTarget> = {}): NFSDelegateTarget {
  return {
    lookup: () => Promise.resolve(7),
    getattr: () => Promise.resolve(ATTRS),
    read: () => Promise.resolve(Buffer.from('abc')),
    write: () => Promise.resolve(ATTRS),
    create: () => Promise.resolve(7),
    mkdir: () => Promise.resolve(7),
    remove: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    setSize: () => Promise.resolve(ATTRS),
    symlink: () => Promise.resolve(7),
    readlink: () => Promise.resolve('target.txt'),
    readdir: () => Promise.resolve([]),
    flushIdle: () => Promise.resolve(),
    ...overrides,
  }
}

describe('mountArgs', () => {
  it('pins port, mountport and actimeo on darwin', () => {
    const argv = mountArgs('/tmp/m', 20490, '/docs', 'darwin')
    expect(argv[0]).toBe('mount_nfs')
    const joined = argv.join(' ')
    expect(joined).toContain('port=20490')
    expect(joined).toContain('mountport=20490')
    expect(joined).toContain('actimeo=0')
    expect(argv.at(-2)).toBe('127.0.0.1:/docs')
    expect(argv.at(-1)).toBe('/tmp/m')
  })

  it('uses mount -t nfs on linux', () => {
    const argv = mountArgs('/tmp/m', 111, '/', 'linux')
    expect(argv.slice(0, 3)).toEqual(['mount', '-t', 'nfs'])
    // linux spells the no-lock option without the trailing s
    expect(argv.join(' ')).toContain('nolock,')
    expect(argv.at(-2)).toBe('127.0.0.1:/')
  })
})

describe('umountArgs', () => {
  it('is plain umount on every platform', () => {
    expect(umountArgs('/tmp/m', 'linux')).toEqual(['umount', '/tmp/m'])
    expect(umountArgs('/tmp/m', 'darwin')).toEqual(['umount', '/tmp/m'])
  })
})

describe('prepareMountpoint', () => {
  it('creates and owns a temporary directory when unnamed', () => {
    const [path, owns] = prepareMountpoint()
    try {
      expect(owns).toBe(true)
      expect(statSync(path).isDirectory()).toBe(true)
    } finally {
      rmdirSync(path)
    }
  })

  it('keeps ownership with the caller for a named path', () => {
    const base = mkdtempSync(join(tmpdir(), 'mirage-nfs-test-'))
    const wanted = join(base, 'mnt')
    try {
      const [path, owns] = prepareMountpoint(wanted)
      expect(path).toBe(wanted)
      expect(owns).toBe(false)
      expect(statSync(wanted).isDirectory()).toBe(true)
    } finally {
      rmdirSync(wanted)
      rmdirSync(base)
    }
  })
})

describe('awaitIsMount', () => {
  it('fails loudly, naming the mountpoint, when no mount appears', async () => {
    await expect(awaitIsMount('/tmp/never', 0.05, () => Promise.resolve(false))).rejects.toThrow(
      '/tmp/never',
    )
  })

  it('returns as soon as the probe passes', async () => {
    await expect(awaitIsMount('/tmp/now', 1, () => Promise.resolve(true))).resolves.toBeUndefined()
  })

  it('reads an ordinary directory as not a mount', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-nfs-test-'))
    try {
      expect(await isMountPoint(dir)).toBe(false)
    } finally {
      rmdirSync(dir)
    }
  })

  it('never reads a symlink as a mount', async () => {
    // CPython's rule: a symlink can never be a mount point, and
    // following it would report the target's boundary as this path's.
    const base = mkdtempSync(join(tmpdir(), 'mirage-nfs-test-'))
    const link = join(base, 'link')
    symlinkSync(base, link)
    try {
      expect(await isMountPoint(link)).toBe(false)
    } finally {
      unlinkSync(link)
      rmdirSync(base)
    }
  })

  it('reads a filesystem root as a mount', async () => {
    // The other half of the rule: / shares its inode with /.., which is
    // how a root is told from an ordinary directory.
    expect(await isMountPoint('/')).toBe(true)
  })
})

describe('buildDelegate', () => {
  it('answers an id reply for lookup', async () => {
    const d = buildDelegate(target())
    expect(await d.lookup({ dirId: 1, name: 'a.txt' })).toEqual({ fileid: 7 })
  })

  it('classifies a backend failure onto an errno reply', async () => {
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    const d = buildDelegate(
      target({
        lookup: () => Promise.reject(missing),
      }),
    )
    expect(await d.lookup({ dirId: 1, name: 'gone' })).toEqual({ errno: ENOENT })
  })

  it('answers a stale id with the wire table ESTALE, not the host errno', async () => {
    // bridge.rs maps 70 onto NFS3ERR_STALE; ESTALE is 116 on linux, so the
    // number has to come from the addon's table rather than node:os.
    const d = buildDelegate(
      target({
        getattr: () => Promise.reject(new StaleHandleError('unknown file id: 9')),
      }),
    )
    expect(ESTALE_WIRE).toBe(70)
    expect(await d.getattr({ id: 9 })).toMatchObject({ errno: ESTALE_WIRE })
  })

  it('carries every required attrs field on a failed attrs reply', async () => {
    // Attrs is a napi object whose fileid/size/isDir/isSymlink are NOT
    // Option, so a bare { errno } fails to deserialize on the rust side and
    // the client sees SERVERFAULT instead of the real condition.
    const d = buildDelegate(
      target({
        getattr: () => Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' })),
      }),
    )
    expect(await d.getattr({ id: 9 })).toEqual({
      errno: ENOENT,
      fileid: 9,
      size: 0,
      isDir: false,
      isSymlink: false,
    })
  })

  it('refuses a rename into its own subtree with EINVAL', async () => {
    const d = buildDelegate(
      target({
        rename: () =>
          Promise.reject(new RenameIntoSelfError('cannot rename /d into its own subtree /d/x')),
      }),
    )
    expect(await d.rename({ fromDirId: 1, fromName: 'd', toDirId: 2, toName: 'x' })).toEqual({
      errno: EINVAL,
    })
  })

  it('answers read with the bytes and write with attrs', async () => {
    const seen: { offset: number; data: Buffer }[] = []
    const d = buildDelegate(
      target({
        read: (_id, offset, count) =>
          Promise.resolve(Buffer.from('x'.repeat(count) + String(offset))),
        write: (_id, offset, data) => {
          seen.push({ offset, data })
          return Promise.resolve(ATTRS)
        },
      }),
    )
    expect(await d.read({ id: 7, offset: 2, count: 3 })).toEqual({ data: Buffer.from('xxx2') })
    expect(await d.write({ id: 7, offset: 4, data: Buffer.from('hi') })).toEqual(ATTRS)
    expect(seen).toEqual([{ offset: 4, data: Buffer.from('hi') }])
  })

  it('passes an absent setattr size through as null', async () => {
    const sizes: (number | null)[] = []
    const d = buildDelegate(
      target({
        setSize: (_id, size) => {
          sizes.push(size)
          return Promise.resolve(ATTRS)
        },
      }),
    )
    await d.setSize({ id: 7, size: 12 })
    await d.setSize({ id: 7 })
    await d.setSize({ id: 7, size: null })
    expect(sizes).toEqual([12, null, null])
  })

  it('drops the cookie from a listing entry, which rides inside attrs', async () => {
    // DirEntryOut is { name, attrs } — vfs.rs reads the id off attrs.fileid,
    // so a per-entry fileid/cookie field would be silently ignored.
    const entries: DirEntry[] = [
      { name: 'a.txt', fileid: 7, cookie: 7, attrs: ATTRS },
      { name: 'b', fileid: 8, cookie: 8, attrs: { ...ATTRS, fileid: 8, isDir: true, size: 0 } },
    ]
    const d = buildDelegate(target({ readdir: () => Promise.resolve(entries) }))
    expect(await d.readdir({ dirId: 1, startAfter: 0, maxEntries: 10 })).toEqual({
      entries: [
        { name: 'a.txt', attrs: ATTRS },
        { name: 'b', attrs: { ...ATTRS, fileid: 8, isDir: true, size: 0 } },
      ],
    })
  })

  it('resumes a listing after the cookie the client returned', async () => {
    const asked: [number, number, number][] = []
    const d = buildDelegate(
      target({
        readdir: (dirid, cookie, maxEntries) => {
          asked.push([dirid, cookie, maxEntries])
          return Promise.resolve([])
        },
      }),
    )
    await d.readdir({ dirId: 3, startAfter: 42, maxEntries: 5 })
    expect(asked).toEqual([[3, 42, 5]])
  })

  it('answers readlink with text and remove/flushIdle with a unit reply', async () => {
    const d = buildDelegate(target())
    expect(await d.readlink({ id: 7 })).toEqual({ text: 'target.txt' })
    expect(await d.remove({ dirId: 1, name: 'a.txt' })).toEqual({})
    expect(await d.flushIdle({ id: 0 })).toEqual({})
  })

  it('never lets an idle-flush failure escape to the addon', async () => {
    const d = buildDelegate(
      target({
        flushIdle: () => Promise.reject(new Error('backend down')),
      }),
    )
    expect(await d.flushIdle({ id: 0 })).toEqual({ errno: 5 })
  })
})

describe('loadAddon', () => {
  it('names the addon and the override when it cannot be loaded', () => {
    expect(ADDON_ENV).toBe('MIRAGE_NFS_ADDON')
    const previous = process.env.MIRAGE_NFS_ADDON
    process.env.MIRAGE_NFS_ADDON = '/nonexistent/mirage_nfs_node.node'
    try {
      expect(() => loadAddon()).toThrow(ADDON_PACKAGE)
      expect(() => loadAddon()).toThrow(ADDON_ENV)
    } finally {
      if (previous === undefined) delete process.env.MIRAGE_NFS_ADDON
      else process.env.MIRAGE_NFS_ADDON = previous
    }
  })

  it('loads a locally built addon named by the override', () => {
    // The addon is not published yet, so this covers the path only on a
    // machine that has built it (integ points the same variable at it).
    const built = fileURLToPath(
      new URL('../../../mirage-nfs/mirage_nfs_node.node', import.meta.url),
    )
    if (!existsSync(built)) return
    const previous = process.env.MIRAGE_NFS_ADDON
    process.env.MIRAGE_NFS_ADDON = built
    try {
      expect(typeof loadAddon().start).toBe('function')
    } finally {
      if (previous === undefined) delete process.env.MIRAGE_NFS_ADDON
      else process.env.MIRAGE_NFS_ADDON = previous
    }
  })
})
