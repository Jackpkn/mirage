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
import { runWithCacheManager } from '../../cache/context.ts'
import { FakeAccessor, FakeManager, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeCreate, makeMkdir, makeTruncate, makeWriteBytes } from './write.ts'

const accessor = new FakeAccessor()
const ENC = new TextEncoder()

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

describe('object_store write', () => {
  it('write puts and invalidates every ancestor listing', async () => {
    const store = new FakeStore()
    const manager = await managed(() =>
      makeWriteBytes(makeDriver(store))(accessor, spec('/a/b/c.txt'), ENC.encode('hi')),
    )
    expect(store.contents()).toEqual({ 'a/b/c.txt': 'hi' })
    expect(manager.writes).toEqual(['/a/b/c.txt', '/a/b', '/a'])
  })

  it('write at the mount root invalidates only itself', async () => {
    const store = new FakeStore()
    const manager = await managed(() =>
      makeWriteBytes(makeDriver(store))(accessor, spec('/c.txt'), ENC.encode('x')),
    )
    expect(manager.writes).toEqual(['/c.txt'])
  })

  it('create puts empty and invalidates ancestors', async () => {
    const store = new FakeStore()
    const manager = await managed(() => makeCreate(makeDriver(store))(accessor, spec('/a/b/c.txt')))
    expect(store.contents()).toEqual({ 'a/b/c.txt': '' })
    expect(manager.writes).toEqual(['/a/b/c.txt', '/a/b', '/a'])
  })

  it('truncate pads with NUL and invalidates ancestors', async () => {
    const store = new FakeStore({ 'a/f.bin': '0123456789' })
    const manager = await managed(() =>
      makeTruncate(makeDriver(store))(accessor, spec('/a/f.bin'), 4),
    )
    expect(store.text('a/f.bin')).toBe('0123')
    expect(manager.writes).toEqual(['/a/f.bin', '/a'])
  })

  it('truncate extends a missing key', async () => {
    const store = new FakeStore()
    await managed(() => makeTruncate(makeDriver(store))(accessor, spec('/f.bin'), 3))
    expect(store.text('f.bin')).toBe('\0\0\0')
  })

  it('mkdir writes a marker and parents gate ancestors', async () => {
    const store = new FakeStore()
    const manager = await managed(() => makeMkdir(makeDriver(store))(accessor, spec('/a/b')))
    expect(store.contents()).toEqual({ 'a/b/': '' })
    expect(manager.writes).toEqual(['/a/b'])
    const deep = await managed(() => makeMkdir(makeDriver(store))(accessor, spec('/x/y'), true))
    expect(deep.writes).toEqual(['/x/y', '/x'])
  })
})
