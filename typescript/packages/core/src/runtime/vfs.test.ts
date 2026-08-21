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

import { describe, expect, it, vi } from 'vitest'
import { enotsup } from '../utils/errors.ts'
import { CrossMountError } from './errors.ts'
import type { BridgeDispatchFn } from './types.ts'
import { RuntimeVFS } from './vfs.ts'
import { PrefixResolver } from './resolver.ts'

const enc = new TextEncoder()

describe('RuntimeVFS transport', () => {
  it('forwards read to dispatch read and returns bytes', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    const out = await new RuntimeVFS(dispatch).read('/ram/x.txt')
    expect(dispatch).toHaveBeenCalledWith('read', '/ram/x.txt')
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('forwards write to dispatch write with bytes and resolves void', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch).write('/ram/x.txt', new Uint8Array([9, 9]))
    const call = dispatch.mock.calls[0]
    if (call === undefined) throw new Error('unreachable')
    const [op, path, bytes] = call
    if (bytes === undefined) throw new Error('unreachable')
    expect(op).toBe('write')
    expect(path).toBe('/ram/x.txt')
    expect(Array.from(bytes)).toEqual([9, 9])
  })

  it('resolves each readdir name through stat', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir') return Promise.resolve(['/ram/a.txt', '/ram/sub'])
      return Promise.resolve({
        size: path === '/ram/a.txt' ? 4 : 0,
        isDir: path === '/ram/sub',
        mtimeMs: 0,
        mode: 0,
      })
    })
    const entries = await new RuntimeVFS(dispatch).readdir('/ram/')
    expect(entries).toEqual([
      { path: '/ram/a.txt', size: 4, isDir: false },
      { path: '/ram/sub', size: 0, isDir: true },
    ])
  })

  // A backend that slash-marks its directories has already said what the
  // entry is, so the door does not pay a stat to hear it again.
  it('takes a trailing slash as the answer and skips the stat', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/sub/'])
      throw new Error('stat should not be called')
    })
    expect(await new RuntimeVFS(dispatch).readdir('/ram/')).toEqual([
      { path: '/ram/sub/', size: 0, isDir: true },
    ])
  })

  // A dangling link, or an entry that vanished between the listing and
  // the stat, must not fail the whole listing.
  it('degrades a missing entry to a zero row', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/gone'])
      return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    })
    expect(await new RuntimeVFS(dispatch).readdir('/ram/')).toEqual([
      { path: '/ram/gone', size: 0, isDir: false },
    ])
  })

  it('propagates a stat failure that is not a missing path', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/a.txt'])
      return Promise.reject(new Error('401 Unauthorized'))
    })
    await expect(new RuntimeVFS(dispatch).readdir('/ram/')).rejects.toThrow('401 Unauthorized')
  })

  // The mark is the name plane's, since stat follows a link and no
  // backend listing reports one.
  it('marks the names the resolver calls links', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/lnk', '/ram/a.txt'])
      return Promise.resolve({ size: 2, isDir: false, mtimeMs: 0, mode: 0 })
    })
    const resolver = new PrefixResolver(
      () => ['/ram/'],
      () => new Set(['lnk']),
    )
    expect(await new RuntimeVFS(dispatch, resolver).readdir('/ram/')).toEqual([
      { path: '/ram/lnk', size: 2, isDir: false, isLink: true },
      { path: '/ram/a.txt', size: 2, isDir: false },
    ])
  })

  // Every shape a backend answers in reaches the same mark: the name is
  // the part they agree on.
  it('marks a link whatever shape the entry arrived in', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['lnk', '/ram/dirlink/'])
      return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    })
    const resolver = new PrefixResolver(
      () => ['/ram/'],
      () => new Set(['lnk', 'dirlink']),
    )
    expect(await new RuntimeVFS(dispatch, resolver).readdir('/ram/')).toEqual([
      { path: 'lnk', size: 0, isDir: false, isLink: true },
      { path: '/ram/dirlink/', size: 0, isDir: true, isLink: true },
    ])
  })

  it('marks nothing when no link source was supplied', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/lnk'])
      return Promise.resolve({ size: 0, isDir: false, mtimeMs: 0, mode: 0 })
    })
    const entries = await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/ram/'])).readdir(
      '/ram/',
    )
    expect(entries).toEqual([{ path: '/ram/lnk', size: 0, isDir: false }])
  })

  // The target rides the `dst` slot: it is the op's second string and a
  // link stores it verbatim, so there is nothing a separate slot would
  // say.
  it('forwards symlink to dispatch symlink with the target', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch).symlink('/ram/link', '../t.txt')
    expect(dispatch).toHaveBeenCalledWith('symlink', '/ram/link', undefined, '../t.txt')
  })

  it('forwards readlink and returns the target', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve('../t.txt'))
    const out = await new RuntimeVFS(dispatch).readlink('/ram/link')
    expect(dispatch).toHaveBeenCalledWith('readlink', '/ram/link')
    expect(out).toBe('../t.txt')
  })

  it('refuses a readlink answer that is not a string', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(7))
    await expect(new RuntimeVFS(dispatch).readlink('/ram/link')).rejects.toThrow(/expected string/)
  })

  it('forwards setattr with the fields it was given', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch).setattr('/ram/f', { mode: 0o600, nofollow: true })
    expect(dispatch).toHaveBeenCalledWith('setattr', '/ram/f', undefined, undefined, {
      mode: 0o600,
      nofollow: true,
    })
  })

  it('rethrows dispatch errors', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('boom')))
    await expect(new RuntimeVFS(dispatch).read('/x')).rejects.toThrow(/boom/)
  })

  it('throws TypeError when read returns non-Uint8Array', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve('not bytes' as unknown as Uint8Array),
    )
    await expect(new RuntimeVFS(dispatch).read('/x')).rejects.toThrow(TypeError)
  })

  it('throws TypeError when readdir returns non-array', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve({ not: 'array' } as unknown as never[]),
    )
    await expect(new RuntimeVFS(dispatch).readdir('/x')).rejects.toThrow(TypeError)
  })

  it('throws TypeError when a readdir entry is not a name', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve([{ path: '/x' }] as unknown as never[]),
    )
    await expect(new RuntimeVFS(dispatch).readdir('/x')).rejects.toThrow(TypeError)
  })

  it('throws TypeError when write dispatch returns non-undefined', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve('unexpected' as unknown))
    await expect(new RuntimeVFS(dispatch).write('/x', new Uint8Array([1]))).rejects.toThrow(
      TypeError,
    )
  })

  it('throws TypeError when stat returns a bad shape', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve({ size: 1 }))
    await expect(new RuntimeVFS(dispatch).stat('/x')).rejects.toThrow(TypeError)
  })

  it('forwards create and truncate as their own ops, never a write', async () => {
    // The bridge used to lack both verbs, so quickjs faked them with
    // write: the ledger recorded the wrong op and a backend with a
    // native truncate got a whole-file write instead.
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const vfs = new RuntimeVFS(dispatch)
    await vfs.create('/ram/new.txt')
    await vfs.truncate('/ram/old.txt')
    expect(dispatch.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['create', '/ram/new.txt'],
      ['truncate', '/ram/old.txt'],
    ])
  })
})

describe('RuntimeVFS routing', () => {
  const noop = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))

  it('normalizes prefixes to a trailing slash, longest first', () => {
    const vfs = new RuntimeVFS(noop, new PrefixResolver(() => ['/a', '/a/deep/', '/b']))
    expect(vfs.prefixes()).toEqual(['/a/deep/', '/a/', '/b/'])
  })

  it('picks the longest matching mount, and the prefix itself counts', () => {
    const vfs = new RuntimeVFS(noop, new PrefixResolver(() => ['/a', '/a/deep']))
    expect(vfs.mountOf('/a/deep/x')).toBe('/a/deep/')
    expect(vfs.mountOf('/a/deep')).toBe('/a/deep/')
    expect(vfs.mountOf('/a/x')).toBe('/a/')
    expect(vfs.mountOf('/elsewhere')).toBeNull()
  })

  it('answers no mount when none are wired', () => {
    expect(new RuntimeVFS(noop).mountOf('/a/x')).toBeNull()
  })

  it('refuses a rename whose ends are on different mounts', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const vfs = new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a', '/b']))
    await expect(vfs.rename('/a/x', '/b/x')).rejects.toThrow(CrossMountError)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches a rename within one mount', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).rename('/a/x', '/a/y')
    expect(dispatch).toHaveBeenCalledWith('rename', '/a/x', undefined, '/a/y')
  })
})

describe('RuntimeVFS append', () => {
  it('ships only the tail when the mount takes an append', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
    )
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['append'])
  })

  it('writes the whole file the caller supplied when the mount has no append', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      return Promise.resolve(undefined)
    })
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
      enc.encode('headtail'),
    )
    const write = dispatch.mock.calls.find((c) => c[0] === 'write')
    if (write?.[2] === undefined) throw new Error('unreachable')
    expect(new TextDecoder().decode(write[2])).toBe('headtail')
  })

  it('reads the base itself when no whole file was supplied', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.resolve(enc.encode('head'))
      return Promise.resolve(undefined)
    })
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
    )
    const write = dispatch.mock.calls.find((c) => c[0] === 'write')
    if (write?.[2] === undefined) throw new Error('unreachable')
    expect(new TextDecoder().decode(write[2])).toBe('headtail')
  })

  it('starts from an empty base when the file is simply absent', async () => {
    const missing = Object.assign(new Error('nope'), { code: 'ENOENT' })
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.reject(missing)
      return Promise.resolve(undefined)
    })
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
    )
    const write = dispatch.mock.calls.find((c) => c[0] === 'write')
    if (write?.[2] === undefined) throw new Error('unreachable')
    expect(new TextDecoder().decode(write[2])).toBe('tail')
  })

  it('propagates a read failure that is not an absence', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.reject(new Error('transport down'))
      return Promise.resolve(undefined)
    })
    await expect(
      new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).append('/a/x', enc.encode('tail')),
    ).rejects.toThrow(/transport down/)
    expect(dispatch.mock.calls.some((c) => c[0] === 'write')).toBe(false)
  })

  it('remembers a mount that declined, so it costs one failed dispatch', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      return Promise.resolve(undefined)
    })
    const vfs = new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a']))
    await vfs.append('/a/x', enc.encode('1'), enc.encode('1'))
    await vfs.append('/a/y', enc.encode('2'), enc.encode('2'))
    expect(dispatch.mock.calls.filter((c) => c[0] === 'append')).toHaveLength(1)
  })

  it('lets a real append failure propagate instead of writing whole', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(new Error('mount is read-only'))
      return Promise.resolve(undefined)
    })
    await expect(
      new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).append(
        '/a/x',
        enc.encode('t'),
        enc.encode('t'),
      ),
    ).rejects.toThrow(/read-only/)
    expect(dispatch.mock.calls.some((c) => c[0] === 'write')).toBe(false)
  })
})

describe('RuntimeVFS flush', () => {
  it('sends a pure extension as an append', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).flush(
      '/a/x',
      3,
      3,
      enc.encode('abcXYZ'),
    )
    const call = dispatch.mock.calls[0]
    if (call?.[2] === undefined) throw new Error('unreachable')
    expect(call[0]).toBe('append')
    expect(new TextDecoder().decode(call[2])).toBe('XYZ')
  })

  it('sends a rewrite as a whole-file write', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeVFS(dispatch, new PrefixResolver(() => ['/a'])).flush(
      '/a/x',
      3,
      0,
      enc.encode('ZZZdef'),
    )
    const call = dispatch.mock.calls[0]
    if (call?.[2] === undefined) throw new Error('unreachable')
    expect(call[0]).toBe('write')
    expect(new TextDecoder().decode(call[2])).toBe('ZZZdef')
  })
})
