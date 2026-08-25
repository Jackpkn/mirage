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
import { commentPull, listPulls } from './pull.ts'

describe('commentPull', () => {
  it('preflights the pull request number', async () => {
    const calls: { method: string; path: string }[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        calls.push({ method: 'GET', path })
        return Promise.reject(new Error('not a pull request'))
      },
      request: (method, path) => {
        calls.push({ method, path })
        return Promise.resolve({})
      },
    }

    await expect(commentPull(transport, { owner: 'o', repo: 'r' }, 4, 'no')).rejects.toThrow(
      'not a pull request',
    )
    expect(calls).toEqual([{ method: 'GET', path: '/repos/o/r/pulls/4' }])
  })
})

describe('listPulls', () => {
  it('filters before applying the limit', async () => {
    const seen: string[] = []
    const transport: GitHubTransport = {
      get: (_path, params = {}) => {
        seen.push(params.page ?? '')
        return Promise.resolve(
          params.page === '1'
            ? [{ number: 2, merged_at: null }]
            : [{ number: 1, merged_at: 'now' }],
        )
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }

    const rows = await listPulls(
      transport,
      { owner: 'o', repo: 'r' },
      { state: 'closed' },
      1,
      (row) => row.merged_at !== null,
    )

    expect(rows).toEqual([{ number: 1, merged_at: 'now' }])
    expect(seen).toEqual(['1', '2'])
  })
})
