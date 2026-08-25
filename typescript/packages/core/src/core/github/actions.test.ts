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
import { dispatchWorkflow, getWorkflow, listRuns, listWorkflows } from './actions.ts'

describe('workflow identifiers', () => {
  it('encodes them as one path segment', async () => {
    const calls: { method: string; path: string }[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        calls.push({ method: 'GET', path })
        return Promise.resolve(path.endsWith('/runs') ? { workflow_runs: [] } : {})
      },
      request: (method, path) => {
        calls.push({ method, path })
        return Promise.resolve({})
      },
    }
    const ref = { owner: 'o', repo: 'r' }

    await listRuns(transport, ref, {}, 5, 'ci#nightly.yml')
    await getWorkflow(transport, ref, 'ci#nightly.yml')
    await dispatchWorkflow(transport, ref, 'ci#nightly.yml', { ref: 'main' })

    expect(calls.map((call) => call.path)).toEqual([
      '/repos/o/r/actions/workflows/ci%23nightly.yml/runs',
      '/repos/o/r/actions/workflows/ci%23nightly.yml',
      '/repos/o/r/actions/workflows/ci%23nightly.yml/dispatches',
    ])
  })
})

describe('listWorkflows', () => {
  it('filters before applying the limit', async () => {
    const seen: string[] = []
    const transport: GitHubTransport = {
      get: (_path, params = {}) => {
        seen.push(params.page ?? '')
        const workflows =
          params.page === '1'
            ? [{ id: 2, state: 'disabled_manually' }]
            : [{ id: 1, state: 'active' }]
        return Promise.resolve({ workflows })
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }

    const rows = await listWorkflows(
      transport,
      { owner: 'o', repo: 'r' },
      1,
      (row) => row.state === 'active',
    )

    expect(rows).toEqual([{ id: 1, state: 'active' }])
    expect(seen).toEqual(['1', '2'])
  })
})
