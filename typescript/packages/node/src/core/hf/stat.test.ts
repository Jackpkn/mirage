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

import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { HfModelsAccessor } from '../../accessor/hf.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

function accessorWith(files: Record<string, string | Buffer>): HfModelsAccessor {
  const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
  installFakeOperator(accessor, fakeHfOperator(files))
  return accessor
}

describe('hf stat', () => {
  it('returns a directory stat for root', async () => {
    const accessor = accessorWith({})
    const s = await stat(accessor, PathSpec.fromStrPath('/'))
    expect(s.name).toBe('/')
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('stats a file with size, etag fingerprint, and modified time', async () => {
    const accessor = accessorWith({ 'config.json': '{"a":1}' })
    const s = await stat(accessor, PathSpec.fromStrPath('/config.json'))
    expect(s.name).toBe('config.json')
    expect(s.size).toBe(7)
    expect(s.fingerprint).toBe('etag-7')
    expect(s.extra).toEqual({ etag: 'etag-7' })
    expect(s.modified).toBe('2021-09-15T21:24:22Z')
  })

  it('stats a directory', async () => {
    const accessor = accessorWith({ 'onnx/model.onnx': 'x' })
    const s = await stat(accessor, PathSpec.fromStrPath('/onnx'))
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('onnx')
  })

  it('raises ENOENT for missing paths', async () => {
    const accessor = accessorWith({ 'a.txt': 'x' })
    await expect(stat(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('serves stats from the index cache after readdir without network calls', async () => {
    const accessor = accessorWith({ 'a.txt': 'abc', 'dir/b.txt': 'x' })
    const index = new RAMIndexCacheStore()
    await readdir(accessor, PathSpec.fromStrPath('/'), index)
    const fake = fakeHfOperator({})
    installFakeOperator(accessor, fake)
    const file = await stat(accessor, PathSpec.fromStrPath('/a.txt'), index)
    expect(file.size).toBe(3)
    const dir = await stat(accessor, PathSpec.fromStrPath('/dir'), index)
    expect(dir.type).toBe(FileType.DIRECTORY)
    await expect(stat(accessor, PathSpec.fromStrPath('/missing'), index)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
