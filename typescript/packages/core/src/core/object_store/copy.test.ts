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
import { makeCopy } from './copy.ts'
import { makeExists } from './exists.ts'
import { codeOf, FakeAccessor, FakeManager, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeStat } from './stat.ts'

const accessor = new FakeAccessor()

function copyFor(store: FakeStore) {
  const driver = makeDriver(store)
  return makeCopy(driver, makeExists(makeStat(driver)))
}

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

describe('object_store copy', () => {
  it('duplicates and invalidates destination ancestors', async () => {
    const store = new FakeStore({ 'src.txt': 'hi' })
    const manager = await managed(() =>
      copyFor(store)(accessor, spec('/src.txt'), spec('/a/b/dst.txt')),
    )
    expect(store.contents()).toEqual({ 'src.txt': 'hi', 'a/b/dst.txt': 'hi' })
    expect(manager.writes).toEqual(['/a/b/dst.txt', '/a/b', '/a'])
  })

  it('a missing source is ENOENT', async () => {
    await expect(
      codeOf(managed(() => copyFor(new FakeStore())(accessor, spec('/never'), spec('/dst.txt')))),
    ).resolves.toBe('ENOENT')
  })

  it('copying onto the same key is a guarded no-op', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const manager = await managed(() => copyFor(store)(accessor, spec('/a.txt'), spec('/a.txt')))
    expect(store.contents()).toEqual({ 'a.txt': 'hi' })
    expect(manager.writes).toEqual([])
  })

  it('copying onto the same key still fails when absent', async () => {
    await expect(
      codeOf(managed(() => copyFor(new FakeStore())(accessor, spec('/a.txt'), spec('/a.txt')))),
    ).resolves.toBe('ENOENT')
  })

  it('refuses to build without a native copy', () => {
    const driver = makeDriver(new FakeStore())
    delete driver.copyFile
    expect(() => makeCopy(driver, makeExists(makeStat(driver)))).toThrow('no native copy')
  })
})
