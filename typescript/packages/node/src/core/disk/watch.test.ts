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

import { FileChangeKind, PathSpec, type WalkEntry } from '@struktoai/mirage-core/types'
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskAccessor } from '../../accessor/disk.ts'
import { buildDeltaHook, DiskEventHook, DiskWalk } from './watch.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mirage-watch-disk-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function spec(virtual: string, resourcePath: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath })
}

async function touch(relative: string, body: string, seconds: number): Promise<void> {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body)
  await utimes(target, seconds, seconds)
}

async function collect(walk: DiskWalk, at: PathSpec): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const entry of walk.walk(at)) out.push(entry)
  return out
}

describe('DiskWalk', () => {
  it('reports files and directories', async () => {
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    await touch('data/sub/deep.txt', 'deep', 1_700_000_000)
    const entries = await collect(new DiskWalk(new DiskAccessor(root)), spec('/d/data', 'data'))
    expect(
      entries
        .filter((e) => !e.isDir)
        .map((e) => e.virtual)
        .sort(),
    ).toEqual(['/d/data/a.txt', '/d/data/sub/deep.txt'])
    expect(entries.filter((e) => e.isDir).map((e) => e.virtual)).toEqual(['/d/data/sub'])
  })

  it('carries size and mtime in the composite fingerprint', async () => {
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    const entries = await collect(new DiskWalk(new DiskAccessor(root)), spec('/d/data', 'data'))
    const entry = entries.find((e) => !e.isDir)
    expect(entry?.size).toBe(5)
    expect(entry?.fingerprint).toBe(`${entry?.modified ?? ''}|5`)
  })

  it('walks a missing root as empty', async () => {
    const entries = await collect(new DiskWalk(new DiskAccessor(root)), spec('/d/gone', 'gone'))
    expect(entries).toEqual([])
  })
})

describe('disk delta hook', () => {
  it('reports nothing on the baseline, then create, update and delete', async () => {
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    await touch('data/b.txt', 'beta', 1_700_000_000)
    const hook = buildDeltaHook(new DiskAccessor(root))
    const at = spec('/d/data', 'data')
    const first = await hook.pull(at, null)
    expect(first.changes).toEqual([])

    await touch('data/a.txt', 'gamma', 1_700_000_500)
    await touch('data/c.txt', 'new', 1_700_000_500)
    await rm(path.join(root, 'data/b.txt'))

    const second = await hook.pull(at, first.checkpoint)
    expect(Object.fromEntries(second.changes.map((c) => [c.path.virtual, c.kind]))).toEqual({
      '/d/data/a.txt': FileChangeKind.UPDATE,
      '/d/data/b.txt': FileChangeKind.DELETE,
      '/d/data/c.txt': FileChangeKind.CREATE,
    })
  })

  it('reports nothing for an untouched tree', async () => {
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    const hook = buildDeltaHook(new DiskAccessor(root))
    const at = spec('/d/data', 'data')
    const first = await hook.pull(at, null)
    expect((await hook.pull(at, first.checkpoint)).changes).toEqual([])
  })

  it('reports a new directory', async () => {
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    const hook = buildDeltaHook(new DiskAccessor(root))
    const at = spec('/d/data', 'data')
    const first = await hook.pull(at, null)
    await mkdir(path.join(root, 'data/fresh'))
    const second = await hook.pull(at, first.checkpoint)
    expect(second.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.CREATE, '/d/data/fresh'],
    ])
  })

  it('frames a changed path against the mount', async () => {
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    const hook = buildDeltaHook(new DiskAccessor(root))
    const at = spec('/d/data', 'data')
    const first = await hook.pull(at, null)
    await touch('data/a.txt', 'gamma', 1_700_000_500)
    const second = await hook.pull(at, first.checkpoint)
    expect(second.changes[0]?.path.virtual).toBe('/d/data/a.txt')
    expect(second.changes[0]?.path.resourcePath).toBe('data/a.txt')
  })
})

describe('unreadable directories', () => {
  it('aborts the walk rather than reporting the subtree empty', async () => {
    // An unreadable subtree is not an empty one. Swallowing the error
    // diffs into a DELETE for every child, then a CREATE for each once
    // access returns, so the walk fails and the checkpoint stands.
    await touch('data/a.txt', 'alpha', 1_700_000_000)
    const locked = path.join(root, 'data', 'locked')
    await mkdir(locked)
    await writeFile(path.join(locked, 'inner.txt'), 'inner')
    await chmod(locked, 0o000)
    try {
      await expect(
        collect(new DiskWalk(new DiskAccessor(root)), spec('/d/data', 'data')),
      ).rejects.toThrow()
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('reports nothing for a root that is simply gone', async () => {
    const entries = await collect(new DiskWalk(new DiskAccessor(root)), spec('/d/gone', 'gone'))
    expect(entries).toEqual([])
  })
})

describe('DiskEventHook', () => {
  function map(eventType: string, payload: unknown) {
    return new DiskEventHook(new DiskAccessor(root)).toEvents(
      spec('/d/data', 'data'),
      eventType,
      payload as never,
    )
  }

  it('maps a create to the virtual path', async () => {
    const events = await map('created', { src_path: path.join(root, 'data', 'a.txt') })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe(FileChangeKind.CREATE)
    expect(events[0]?.path.virtual).toBe('/d/data/a.txt')
    expect(events[0]?.path.resourcePath).toBe('data/a.txt')
  })

  it('maps modified and deleted', async () => {
    const target = path.join(root, 'data', 'a.txt')
    expect((await map('modified', { src_path: target }))[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect((await map('deleted', { src_path: target }))[0]?.kind).toBe(FileChangeKind.DELETE)
  })

  it('maps a move to both sides', async () => {
    const events = await map('moved', {
      src_path: path.join(root, 'data', 'old.txt'),
      dest_path: path.join(root, 'data', 'new.txt'),
    })
    expect(events[0]?.kind).toBe(FileChangeKind.MOVE)
    expect(events[0]?.path.virtual).toBe('/d/data/new.txt')
    expect(events[0]?.previousPath?.virtual).toBe('/d/data/old.txt')
  })

  it('reports a move out of the mount as a delete', async () => {
    const events = await map('moved', {
      src_path: path.join(root, 'data', 'old.txt'),
      dest_path: '/elsewhere/new.txt',
    })
    expect(events[0]?.kind).toBe(FileChangeKind.DELETE)
    expect(events[0]?.path.virtual).toBe('/d/data/old.txt')
  })

  it('ignores a path outside the mount', async () => {
    expect(await map('created', { src_path: '/elsewhere/a.txt' })).toEqual([])
  })

  it('ignores an unknown event type', async () => {
    expect(await map('opened', { src_path: path.join(root, 'data', 'a.txt') })).toEqual([])
  })

  it('reports a move into the mount as a create', async () => {
    const events = await map('moved', {
      src_path: '/elsewhere/old.txt',
      dest_path: path.join(root, 'data', 'new.txt'),
    })
    expect(events[0]?.kind).toBe(FileChangeKind.CREATE)
    expect(events[0]?.path.virtual).toBe('/d/data/new.txt')
    expect(events[0]?.previousPath).toBeNull()
  })

  it('ignores a move that touches neither side', async () => {
    expect(
      await map('moved', { src_path: '/elsewhere/old.txt', dest_path: '/nowhere/new.txt' }),
    ).toEqual([])
  })

  it('normalizes the mount root', async () => {
    const events = await map('modified', { src_path: root })
    expect(events[0]?.path.virtual).toBe('/d')
    expect(events[0]?.path.resourcePath).toBe('')
  })

  it('ignores a payload without a path', async () => {
    expect(await map('created', { nothing: 'here' })).toEqual([])
    expect(await map('created', 'not-an-object')).toEqual([])
  })
})
