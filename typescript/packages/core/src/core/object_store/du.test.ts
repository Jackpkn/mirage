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
import { makeDuEntries, makeDuSize } from './du.ts'
import { FakeAccessor, FakeStore, makeDriver, spec } from './fakes.ts'

const accessor = new FakeAccessor()

const STORE = {
  'data/a.txt': '12345',
  'data/sub/b.txt': '123',
  'data-old/c.txt': '1',
}

describe('object_store du', () => {
  it('entries reports sizes and total', async () => {
    const entries = makeDuEntries(makeDriver(new FakeStore(STORE)))
    const [found, total] = await entries(accessor, spec('/data'))
    expect(found).toEqual([
      ['/data/a.txt', 5],
      ['/data/sub/b.txt', 3],
    ])
    expect(total).toBe(8)
  })

  it('size matches the entries total', async () => {
    const driver = makeDriver(new FakeStore(STORE))
    const [, total] = await makeDuEntries(driver)(accessor, spec('/data'))
    await expect(makeDuSize(driver)(accessor, spec('/data'))).resolves.toBe(total)
  })

  it('a single file counts just itself', async () => {
    const size = makeDuSize(makeDriver(new FakeStore(STORE)))
    await expect(size(accessor, spec('/data/a.txt'))).resolves.toBe(5)
  })
})
