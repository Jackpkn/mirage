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
import { FileType } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mkdir } from '../../core/opfs/mkdir.ts'
import { writeBytes } from '../../core/opfs/write.ts'
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { statOp } from './stat.ts'

describe('statOp (opfs)', () => {
  it('returns FileStat with size for files', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/x'), new TextEncoder().encode('abc'))
    const s = (await statOp.fn(accessor, spec('/x'), [], {})) as FileStat
    expect(s.size).toBe(3)
    expect(s.type).not.toBe(FileType.DIRECTORY)
  })
  it('returns DIRECTORY for directories', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    const s = (await statOp.fn(accessor, spec('/d'), [], {})) as FileStat
    expect(s.type).toBe(FileType.DIRECTORY)
  })
})
