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
import { fetchDirTree, fetchTree, type GitHubTransport } from './_client.ts'
import { GitHubAccessor } from '../../accessor/github.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ensureLiveIndex, populateIndex } from './tree.ts'

const ITEMS = [
  { path: 'extern', mode: '160000', type: 'commit', sha: 'ccc' },
  { path: 'main.py', mode: '100644', type: 'blob', sha: 'bbb', size: 7 },
  { path: 'src', mode: '040000', type: 'tree', sha: 'aaa' },
]

function transport(): GitHubTransport {
  return {
    get: () => Promise.resolve({ tree: ITEMS, truncated: false }),
  } as unknown as GitHubTransport
}

describe('github tree fetch', () => {
  it('excludes submodule gitlinks from the recursive tree', async () => {
    const { tree, truncated } = await fetchTree(transport(), 'acme', 'proj', 'main')
    expect(truncated).toBe(false)
    expect(tree.map((e) => e.path)).toEqual(['main.py', 'src'])
  })

  it('excludes submodule gitlinks from per-directory trees', async () => {
    const entries = await fetchDirTree(transport(), 'acme', 'proj', 'sha1')
    expect(entries.map((e) => e.path)).toEqual(['main.py', 'src'])
  })
})

describe('ensureLiveIndex', () => {
  const TREE = {
    data: { path: 'data', type: 'tree', sha: 't1', size: null },
    'data/keep.txt': { path: 'data/keep.txt', type: 'blob', sha: 'b1', size: 4 },
  }

  function accessor(calls: { n: number }): GitHubAccessor {
    return new GitHubAccessor({
      transport: {
        get: () => {
          calls.n += 1
          return Promise.resolve({
            tree: [
              { path: 'data', type: 'tree' as const, sha: 't1' },
              { path: 'data/keep.txt', type: 'blob' as const, sha: 'b1', size: 4 },
            ],
            truncated: false,
          })
        },
      } as unknown as GitHubTransport,
      owner: 'acme',
      repo: 'proj',
      ref: 'main',
      defaultBranch: 'main',
      tree: TREE,
    })
  }

  it('refetches rather than reuse the build-time tree', async () => {
    // The build tree is only true at build time: a mount's first read can
    // come long after it, so reusing it would key an index built from a
    // repository several external writes ago.
    const calls = { n: 0 }
    const index = new RAMIndexCacheStore({ ttl: 600 })
    expect(await ensureLiveIndex(accessor(calls), index, '/gh')).toBe(true)
    expect(calls.n).toBe(1)
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('refetches a dropped listing', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await ensureLiveIndex(acc, index, '/gh')
    // What invalidation does: drop the row rather than expire it, which is
    // why the readers' EXPIRED probe never fires.
    await index.invalidateDir('/gh')
    await index.invalidateDir('/gh/data')
    expect(await ensureLiveIndex(acc, index, '/gh')).toBe(true)
    expect(calls.n).toBe(2)
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('leaves a live index alone and sends no request', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await ensureLiveIndex(acc, index, '/gh')
    const before = calls.n
    expect(await ensureLiveIndex(acc, index, '/gh')).toBe(false)
    expect(calls.n).toBe(before)
  })

  it('skips a truncated tree', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    acc.truncated = true
    expect(await ensureLiveIndex(acc, new RAMIndexCacheStore({ ttl: 600 }), '/gh')).toBe(false)
    expect(calls.n).toBe(0)
  })

  it('skips a missing index', async () => {
    expect(await ensureLiveIndex(accessor({ n: 0 }), undefined, '')).toBe(false)
  })
})

describe('populateIndex', () => {
  const TREE = {
    data: { path: 'data', type: 'tree', sha: 't1', size: null },
    'data/keep.txt': { path: 'data/keep.txt', type: 'blob', sha: 'b1', size: 4 },
  }

  it('keys by mount-absolute path', async () => {
    // Every other backend keys its index this way, which is what lets the
    // shared CacheManager spell an eviction without knowing the backend.
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await populateIndex(index, TREE, '/gh')
    expect((await index.listDir('/gh')).entries).toEqual(['/gh/data'])
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('keeps bare paths on a root mount', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await populateIndex(index, TREE, '')
    expect((await index.listDir('/')).entries).toEqual(['/data'])
  })

  it('gives an empty repo a root row', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await populateIndex(index, {}, '/gh')
    expect((await index.listDir('/gh')).entries).toEqual([])
  })
})
