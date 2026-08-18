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
import { cursorItems } from './paginate.ts'

class Pager {
  readonly cursors: (string | null)[] = []
  constructor(private readonly pages: Record<string, unknown>[]) {}

  fetch = (cursor: string | null): Promise<Record<string, unknown>> => {
    this.cursors.push(cursor)
    const page = this.pages.shift()
    if (page === undefined) throw new Error('fetched past the last page')
    return Promise.resolve(page)
  }
}

describe('cursorItems', () => {
  it('collects across pages and threads the cursor', async () => {
    const pager = new Pager([
      { results: [{ n: 1 }, { n: 2 }], has_more: true, next_cursor: 'c1' },
      { results: [{ n: 3 }], has_more: false },
    ])
    const items = await cursorItems(pager.fetch)
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(pager.cursors).toEqual([null, 'c1'])
  })

  it('maxResults slices the last page', async () => {
    const pager = new Pager([
      { results: [{ n: 1 }, { n: 2 }], has_more: true, next_cursor: 'c1' },
      { results: [{ n: 3 }, { n: 4 }], has_more: true, next_cursor: 'c2' },
    ])
    const items = await cursorItems(pager.fetch, 3)
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(pager.cursors).toHaveLength(2)
  })

  it('has_more without a usable cursor stops', async () => {
    expect(await cursorItems(new Pager([{ results: [{ n: 1 }], has_more: true }]).fetch)).toEqual([
      { n: 1 },
    ])
    expect(
      await cursorItems(
        new Pager([{ results: [{ n: 1 }], has_more: true, next_cursor: '' }]).fetch,
      ),
    ).toEqual([{ n: 1 }])
  })

  it('a non-list results field contributes nothing', async () => {
    expect(
      await cursorItems(new Pager([{ results: { weird: 1 }, has_more: false }]).fetch),
    ).toEqual([])
  })
})
