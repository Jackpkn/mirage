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
import { enoent, enotdir } from '../../utils/errors.ts'
import { IndexEntry } from './config.ts'
import { RAMIndexCacheStore } from './ram.ts'
import { entryOrWarm } from './warm.ts'

const KEY = '/owned/notes.json'

function entryFor(id: string): IndexEntry {
  return new IndexEntry({ id, name: 'notes', resourceType: 'gdocs', vfsName: 'notes.json' })
}

describe('cache/index/warm: entryOrWarm', () => {
  it('returns a warm hit without listing the parent', async () => {
    const index = new RAMIndexCacheStore()
    await index.put(KEY, entryFor('doc-1'))
    let calls = 0
    const got = await entryOrWarm(index, KEY, () => {
      calls += 1
      return Promise.resolve()
    })
    expect(got?.id).toBe('doc-1')
    expect(calls).toBe(0)
  })

  it('lists the parent once on a miss, then serves what the listing put there', async () => {
    const index = new RAMIndexCacheStore()
    let calls = 0
    const got = await entryOrWarm(index, KEY, async () => {
      calls += 1
      await index.put(KEY, entryFor('doc-2'))
    })
    expect(got?.id).toBe('doc-2')
    expect(calls).toBe(1)
  })

  it('returns null when the listing did not produce the entry', async () => {
    const index = new RAMIndexCacheStore()
    const got = await entryOrWarm(index, KEY, () => Promise.resolve())
    expect(got).toBeNull()
  })

  it('returns null without listing when there is no parent to list', async () => {
    const index = new RAMIndexCacheStore()
    const got = await entryOrWarm(index, KEY, null)
    expect(got).toBeNull()
  })

  // The whole point of the helper: exactly one error means "not there".
  it('swallows an absent parent, so the caller can name the operand', async () => {
    const index = new RAMIndexCacheStore()
    const got = await entryOrWarm(index, KEY, () => Promise.reject(enoent('/owned')))
    expect(got).toBeNull()
  })

  it('propagates an auth or transport failure instead of reading as missing', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      entryOrWarm(index, KEY, () => Promise.reject(new Error('401 Unauthorized'))),
    ).rejects.toThrow(/401 Unauthorized/)
  })

  it('propagates a non-ENOENT fs error too, not just untyped ones', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      entryOrWarm(index, KEY, () => Promise.reject(enotdir('/owned'))),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
