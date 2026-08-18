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
import { makeRemovePrefix, makeUnlink } from './remove.ts'

const accessor = new FakeAccessor()

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

describe('object_store remove', () => {
  it('unlink deletes and invalidates every ancestor listing', async () => {
    // Deleting the last key under a/b makes /a/b and /a disappear as
    // implied prefixes; the stale-ancestor eviction is the pinned fix.
    const store = new FakeStore({ 'a/b/c.txt': 'hi' })
    const manager = await managed(() => makeUnlink(makeDriver(store))(accessor, spec('/a/b/c.txt')))
    expect(store.contents()).toEqual({})
    expect(manager.unlinks).toEqual(['/a/b/c.txt'])
    expect(manager.writes).toEqual(['/a/b', '/a'])
  })

  it('removePrefix deletes the subtree and ancestors evict', async () => {
    const store = new FakeStore({ 'a/b/c.txt': 'hi', 'a/b/d/e.txt': 'x' })
    const manager = await managed(() => makeRemovePrefix(makeDriver(store))(accessor, spec('/a/b')))
    expect(store.contents()).toEqual({})
    expect(manager.unlinks).toEqual(['/a/b'])
    expect(manager.writes).toEqual(['/a'])
  })
})
