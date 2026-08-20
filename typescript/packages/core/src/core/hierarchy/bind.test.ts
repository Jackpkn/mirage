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
import { Accessor } from '../../accessor/base.ts'
import { perAccessor } from './bind.ts'

class FakeAccessor extends Accessor {}

describe('perAccessor', () => {
  it('builds once per accessor', () => {
    const built: FakeAccessor[] = []
    const cached = perAccessor((accessor: FakeAccessor) => {
      built.push(accessor)
      return [`routes-${String(built.length)}`]
    })
    const accessor = new FakeAccessor()
    const first = cached(accessor)
    expect(cached(accessor)).toBe(first)
    expect(built).toEqual([accessor])
  })

  it('distinct accessors get distinct builds', () => {
    const cached = perAccessor((_accessor: FakeAccessor) => ({}))
    expect(cached(new FakeAccessor())).not.toBe(cached(new FakeAccessor()))
  })
})
