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
import type { GitHubTransport } from './client.ts'
import { getLatestRelease, getRelease } from './release.ts'

describe('getLatestRelease', () => {
  it('uses the authoritative latest endpoint', async () => {
    const paths: string[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        paths.push(path)
        return Promise.resolve({ tag_name: 'v1' })
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }

    expect(await getLatestRelease(transport, { owner: 'o', repo: 'r' })).toEqual({ tag_name: 'v1' })
    expect(paths).toEqual(['/repos/o/r/releases/latest'])
  })
})

describe('getRelease', () => {
  it('encodes the tag path segment', async () => {
    const paths: string[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        paths.push(path)
        return Promise.resolve({ tag_name: 'v1#hot' })
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }

    expect(await getRelease(transport, { owner: 'o', repo: 'r' }, 'v1#hot')).toEqual({
      tag_name: 'v1#hot',
    })
    expect(paths).toEqual(['/repos/o/r/releases/tags/v1%23hot'])
  })
})
