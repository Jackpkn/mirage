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
import { CacheType } from '../../cache/file/config.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { Workspace } from '../workspace.ts'
import { buildFileCache, registerFileCacheStore, resolveFileCache } from './cache.ts'

describe('buildFileCache', () => {
  it('defaults to RAM sized by cacheLimit', () => {
    const cache = buildFileCache(undefined, 1024)
    expect(cache).toBeInstanceOf(RAMFileCacheStore)
    expect(cache.cacheLimit).toBe(1024)
  })

  it('a config limit wins over the legacy cacheLimit knob', () => {
    const cache = buildFileCache({ type: CacheType.RAM, limit: 2048 }, 1024)
    expect(cache.cacheLimit).toBe(2048)
  })

  it('names the package to import rather than degrading to RAM', () => {
    // Silently handing back a RAM cache would look like it worked while
    // nothing was shared between processes.
    expect(() => buildFileCache({ type: 'memcached' as CacheType })).toThrow(
      /no 'memcached' file cache is registered/,
    )
  })

  it('builds a registered type through its factory', () => {
    const store = new RAMFileCacheStore({ limit: 7 })
    registerFileCacheStore('probe' as CacheType, () => store)
    expect(buildFileCache({ type: 'probe' as CacheType })).toBe(store)
  })
})

describe('resolveFileCache', () => {
  it('passes a built store through untouched, and disclaims it', () => {
    const store = new RAMFileCacheStore({ limit: 8 })
    expect(resolveFileCache(store)).toEqual({ cache: store, owned: false })
  })

  it('owns what it builds', () => {
    expect(resolveFileCache(undefined).owned).toBe(true)
    expect(resolveFileCache({ type: CacheType.RAM }).owned).toBe(true)
  })

  it('lets a workspace take the cache as config, the way index already does', () => {
    const ws = new Workspace({}, { cache: { type: CacheType.RAM, limit: 4096 } })
    expect(ws.cache).toBeInstanceOf(RAMFileCacheStore)
    expect(ws.cache.cacheLimit).toBe(4096)
  })

  it('closes the store it built, and not one it was handed', async () => {
    // A `cache: {type: redis}` config leaves the workspace holding a
    // client that nothing else would close.
    const built = new RAMFileCacheStore({ limit: 4096 })
    let builtClosed = 0
    built.close = () => {
      builtClosed++
      return Promise.resolve()
    }
    registerFileCacheStore('probe-close' as CacheType, () => built)
    const owning = new Workspace({}, { cache: { type: 'probe-close' as CacheType } })
    await owning.close()
    expect(builtClosed).toBe(1)

    const supplied = new RAMFileCacheStore({ limit: 4096 })
    let suppliedClosed = 0
    supplied.close = () => {
      suppliedClosed++
      return Promise.resolve()
    }
    const borrowing = new Workspace({}, { cache: supplied })
    await borrowing.close()
    expect(suppliedClosed).toBe(0)
  })
})
