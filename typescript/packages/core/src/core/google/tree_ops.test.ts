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
import type { Accessor } from '../../accessor/base.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import type { TokenManager } from './_client.ts'
import { makeStat, makeUnlink } from './tree_ops.ts'

// The three Drive-item backends share one synthetic owned/shared tree and
// differ only in the readdir they warm the index with, so the factory is
// exercised through a stub readdir rather than a live backend.
function specFor(virtual: string, resourcePath: string): PathSpec {
  return new PathSpec({ virtual, directory: '/', resolved: true, resourcePath })
}

type DriveAccessor = Accessor & { tokenManager: TokenManager }

const NO_ACCESSOR = {} as Accessor
const NO_DRIVE_ACCESSOR = {} as DriveAccessor

// A path two levels down, so the parent readdir is the one that fails.
const DEEP = '/owned/sub/missing.json'
const DEEP_KEY = 'owned/sub/missing.json'

describe('core/google/tree_ops: makeStat', () => {
  it('reports the synthetic roots as directories without touching readdir', async () => {
    let called = 0
    const stat = makeStat(() => {
      called += 1
      return Promise.resolve([])
    })
    for (const [virtual, key, name] of [
      ['/', '', '/'],
      ['/owned', 'owned', 'owned'],
      ['/shared', 'shared', 'shared'],
    ] as const) {
      const got = await stat(NO_ACCESSOR, specFor(virtual, key), new RAMIndexCacheStore())
      expect(got.type).toBe(FileType.DIRECTORY)
      expect(got.name).toBe(name)
    }
    expect(called).toBe(0)
  })

  it('serves an indexed document without a readdir round trip', async () => {
    const index = new RAMIndexCacheStore()
    await index.put(
      '/owned/notes.json',
      new IndexEntry({
        id: 'doc-1',
        name: 'notes',
        resourceType: 'gdocs',
        vfsName: 'notes.json',
        remoteTime: '2026-01-02T15:30:00Z',
        size: 12,
      }),
    )
    let called = 0
    const stat = makeStat(() => {
      called += 1
      return Promise.resolve([])
    })
    const got = await stat(NO_ACCESSOR, specFor('/owned/notes.json', 'owned/notes.json'), index)
    expect(called).toBe(0)
    expect(got.name).toBe('notes.json')
    expect(got.type).toBe(FileType.JSON)
    expect(got.size).toBe(12)
    expect(got.extra.doc_id).toBe('doc-1')
    expect(got.extra.doc_name).toBe('notes')
  })

  it('warms the parent through readdir, then raises ENOENT when still absent', async () => {
    const seen: string[] = []
    const stat = makeStat((_a: Accessor, p: PathSpec) => {
      seen.push(p.virtual)
      return Promise.resolve([])
    })
    await expect(
      stat(
        NO_ACCESSOR,
        specFor('/owned/missing.json', 'owned/missing.json'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(seen).toEqual(['/owned'])
  })

  it('raises ENOENT with no index rather than reaching the backend', async () => {
    const stat = makeStat(() => Promise.reject(new Error('readdir must not run')))
    await expect(
      stat(NO_ACCESSOR, specFor('/owned/notes.json', 'owned/notes.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// Mirrors test_tree_ops.py: a parent that is merely absent is swallowed so
// the operand gets the ENOENT, but an auth or transport failure must reach
// the caller instead of reading back as "no such file".
describe('core/google/tree_ops: a failed parent listing', () => {
  it('propagates out of stat instead of reporting ENOENT', async () => {
    const stat = makeStat(() => Promise.reject(new Error('google unavailable')))
    await expect(
      stat(NO_ACCESSOR, specFor(DEEP, DEEP_KEY), new RAMIndexCacheStore()),
    ).rejects.toThrow(/google unavailable/)
  })

  it('propagates out of unlink instead of reporting ENOENT', async () => {
    const unlink = makeUnlink((_a: DriveAccessor) =>
      Promise.reject(new Error('google unavailable')),
    )
    await expect(
      unlink(NO_DRIVE_ACCESSOR, specFor(DEEP, DEEP_KEY), new RAMIndexCacheStore()),
    ).rejects.toThrow(/google unavailable/)
  })

  it('names the operand, not the parent, when the parent is absent (stat)', async () => {
    const stat = makeStat((_a: Accessor, p: PathSpec) => Promise.reject(enoent(p.virtual)))
    await expect(
      stat(NO_ACCESSOR, specFor(DEEP, DEEP_KEY), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT', virtualPath: DEEP })
  })

  it('names the operand, not the parent, when the parent is absent (unlink)', async () => {
    const unlink = makeUnlink((_a: DriveAccessor, p: PathSpec) => Promise.reject(enoent(p.virtual)))
    await expect(
      unlink(NO_DRIVE_ACCESSOR, specFor(DEEP, DEEP_KEY), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT', virtualPath: DEEP })
  })
})
