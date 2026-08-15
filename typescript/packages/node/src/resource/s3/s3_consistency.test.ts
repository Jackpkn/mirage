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

import { ConsistencyPolicy, MountMode } from '@struktoai/mirage-core/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import type { S3Config } from './config.ts'
import { installS3Mock, type S3Mock } from './mock.ts'
import { S3Resource } from './s3.ts'

const BUCKET = 'cons-bucket'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function makeConfig(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

describe('S3 cache consistency (mocked)', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock()
  })

  beforeEach(() => {
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v1'))
  })

  afterEach(() => {
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
  })

  afterAll(() => {
    mock.restore()
  })

  it('ALWAYS refetches after the remote object changes out-of-band', async () => {
    const ws = new Workspace(
      { '/s3/': new S3Resource(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
    )
    const first = await ws.execute('cat /s3/c.txt')
    expect(DEC.decode(first.stdout)).toBe('v1')
    // Mutate the object behind the cache's back (different content => new ETag).
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
    const second = await ws.execute('cat /s3/c.txt')
    expect(DEC.decode(second.stdout)).toBe('v2')
    await ws.close()
  })

  it('LAZY keeps serving the cached bytes after an out-of-band change', async () => {
    const ws = new Workspace(
      { '/s3/': new S3Resource(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.LAZY },
    )
    const first = await ws.execute('cat /s3/c.txt')
    expect(DEC.decode(first.stdout)).toBe('v1')
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
    const second = await ws.execute('cat /s3/c.txt')
    expect(DEC.decode(second.stdout)).toBe('v1')
    await ws.close()
  })
})
