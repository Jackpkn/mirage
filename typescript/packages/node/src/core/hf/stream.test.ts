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

import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { HfModelsAccessor } from '../../accessor/hf.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { rangeRead, stream } from './stream.ts'

function accessorWith(files: Record<string, string | Buffer>): HfModelsAccessor {
  const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
  installFakeOperator(accessor, fakeHfOperator(files))
  return accessor
}

describe('hf stream', () => {
  it('streams a file in fixed-size chunks', async () => {
    const accessor = accessorWith({ 'big.bin': 'a'.repeat(10000) })
    const chunks: Uint8Array[] = []
    for await (const chunk of stream(accessor, PathSpec.fromStrPath('/big.bin'))) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.byteLength).toBe(8192)
    expect(chunks[1]?.byteLength).toBe(1808)
    expect(Buffer.concat(chunks).toString()).toBe('a'.repeat(10000))
  })

  it('maps NotFound to ENOENT', async () => {
    const accessor = accessorWith({})
    const iterate = async () => {
      let total = 0
      for await (const chunk of stream(accessor, PathSpec.fromStrPath('/missing'))) {
        total += chunk.byteLength
      }
      return total
    }
    await expect(iterate()).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('hf rangeRead', () => {
  it('reads the [start, end) byte range', async () => {
    const accessor = accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await rangeRead(accessor, PathSpec.fromStrPath('/f.bin'), 2, 5)
    expect(Buffer.from(data).toString()).toBe('cde')
  })

  it('reads from zero', async () => {
    const accessor = accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await rangeRead(accessor, PathSpec.fromStrPath('/f.bin'), 0, 3)
    expect(Buffer.from(data).toString()).toBe('abc')
  })
})
