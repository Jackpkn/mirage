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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './_client.ts'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return { ...actual, loadS3Module: vi.fn(), withClient: vi.fn() }
})

import { S3Accessor } from '../../accessor/s3.ts'
import { runWithCacheManager } from '../../cache/context.ts'
import type { S3Config } from '../../resource/s3/config.ts'
import { PathSpec } from '../../types.ts'
import * as clientMod from './_client.ts'
import { write } from './write.ts'

class FakeManager {
  writes: string[] = []

  invalidateAfterWrite(path: PathSpec): Promise<void> {
    this.writes.push(path.mountPath)
    return Promise.resolve()
  }

  invalidateAfterUnlink(_path: PathSpec): Promise<void> {
    return Promise.resolve()
  }

  cachedBytes(_path: PathSpec): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }
}

class FakeCommand {
  constructor(readonly input: { Key?: string }) {}
}

function mockPut(keys: string[]): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    PutObjectCommand: FakeCommand,
  } as never)
  vi.mocked(clientMod.withClient).mockImplementation(async (_config, fn) => {
    const client = {
      send: (command: FakeCommand) => {
        keys.push(command.input.Key ?? '')
        return Promise.resolve({})
      },
    }
    return (await fn(client as never)) as never
  })
}

async function runWrite(mountPath: string): Promise<{ manager: FakeManager; keys: string[] }> {
  const keys: string[] = []
  mockPut(keys)
  const manager = new FakeManager()
  const accessor = new S3Accessor({ bucket: 'b' } as S3Config)
  const spec = new PathSpec({
    resourcePath: mountPath.replace(/^\//, ''),
    virtual: `/mnt${mountPath}`,
    directory: '/mnt/',
  })
  await runWithCacheManager(manager, async () => {
    await write(accessor, spec, new TextEncoder().encode('hi'))
  })
  return { manager, keys }
}

describe('s3 core write', () => {
  beforeEach(() => {
    vi.mocked(clientMod.loadS3Module).mockReset()
    vi.mocked(clientMod.withClient).mockReset()
  })

  it('invalidates every ancestor listing', async () => {
    const { manager, keys } = await runWrite('/a/b/c.txt')
    expect(keys).toEqual(['a/b/c.txt'])
    // The put materializes `a` and `a/b` too, so their listings are stale.
    expect(manager.writes).toEqual(['/a/b/c.txt', '/a/b', '/a'])
  })

  it('invalidates only itself at the mount root', async () => {
    const { manager } = await runWrite('/c.txt')
    expect(manager.writes).toEqual(['/c.txt'])
  })
})
