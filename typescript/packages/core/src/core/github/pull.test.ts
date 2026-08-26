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
import { commentPull, commitStatuses, listPulls, pullChecks } from './pull.ts'

describe('pullChecks', () => {
  function transportFor(
    checkRuns: unknown[],
    statuses: unknown[],
    seen: string[] = [],
  ): GitHubTransport {
    return {
      get: (path) => {
        seen.push(path)
        if (path.endsWith('/check-runs')) return Promise.resolve({ check_runs: checkRuns })
        if (path.endsWith('/status')) return Promise.resolve({ state: 'success', statuses })
        return Promise.resolve({ head: { sha: 'abc' } })
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }
  }

  it('follows the head sha', async () => {
    const seen: string[] = []

    const rows = await pullChecks(
      transportFor([{ name: 'test' }], [], seen),
      {
        owner: 'o',
        repo: 'r',
      },
      3,
    )

    expect(rows).toEqual([{ name: 'test' }])
    expect(seen).toContain('/repos/o/r/commits/abc/check-runs')
  })

  it('merges commit status contexts', async () => {
    const rows = await pullChecks(
      transportFor(
        [],
        [
          {
            context: 'ci/legacy',
            state: 'failure',
            target_url: 'https://ci.test/1',
            description: 'boom',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:01:00Z',
          },
          { context: 'ci/slow', state: 'pending' },
        ],
      ),
      { owner: 'o', repo: 'r' },
      3,
    )

    expect(rows).toEqual([
      {
        name: 'ci/legacy',
        status: 'completed',
        conclusion: 'failure',
        details_url: 'https://ci.test/1',
        output: { summary: 'boom' },
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:01:00Z',
      },
      {
        name: 'ci/slow',
        status: 'pending',
        conclusion: null,
        details_url: '',
        output: { summary: '' },
        started_at: null,
        completed_at: null,
      },
    ])
  })
})

describe('commitStatuses', () => {
  it('reads the combined endpoint and drops non-objects', async () => {
    const seen: string[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        seen.push(path)
        return Promise.resolve({ state: 'success', statuses: [{ context: 'ci' }, 'junk'] })
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }

    expect(await commitStatuses(transport, { owner: 'o', repo: 'r' }, 'abc')).toEqual([
      { context: 'ci' },
    ])
    expect(seen).toEqual(['/repos/o/r/commits/abc/status'])
  })
})

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
