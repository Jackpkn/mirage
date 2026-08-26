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
import {
  dispatchWorkflow,
  getWorkflow,
  listRuns,
  listWorkflows,
  resolveWorkflow,
} from './actions.ts'

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

describe('resolveWorkflow', () => {
  const named: GitHubTransport = {
    get: (path) =>
      Promise.resolve(
        path.endsWith('/workflows')
          ? {
              workflows: [
                { id: 102, name: 'Archive' },
                { id: 101, name: 'CI' },
              ],
            }
          : {},
      ),
    request: () => Promise.reject(new Error('unexpected request')),
  }

  it.each(['101', 'ci.yml', 'ci.yaml'])('passes %s through without a lookup', async (selector) => {
    const transport: GitHubTransport = {
      get: () => Promise.reject(new Error('an id or filename needs no lookup')),
      request: () => Promise.reject(new Error('unexpected request')),
    }

    expect(await resolveWorkflow(transport, { owner: 'o', repo: 'r' }, selector)).toBe(selector)
  })

  it('matches a display name case insensitively', async () => {
    expect(await resolveWorkflow(named, { owner: 'o', repo: 'r' }, 'ci')).toBe('101')
  })

  it('rejects an unknown display name', async () => {
    await expect(resolveWorkflow(named, { owner: 'o', repo: 'r' }, 'Nightly')).rejects.toThrow(
      'could not find any workflows named Nightly',
    )
  })

  it('sends the resolved id to view, dispatch and run filtering', async () => {
    const calls: string[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        calls.push(path)
        if (path.endsWith('/actions/workflows')) {
          return Promise.resolve({ workflows: [{ id: 101, name: 'CI' }] })
        }
        return Promise.resolve(path.endsWith('/runs') ? { workflow_runs: [] } : {})
      },
      request: (method, path) => {
        calls.push(path)
        return Promise.resolve({})
      },
    }
    const ref = { owner: 'o', repo: 'r' }

    await getWorkflow(transport, ref, 'CI')
    await dispatchWorkflow(transport, ref, 'CI', { ref: 'main' })
    await listRuns(transport, ref, {}, 5, 'CI')

    expect(calls.filter((path) => !path.endsWith('/actions/workflows'))).toEqual([
      '/repos/o/r/actions/workflows/101',
      '/repos/o/r/actions/workflows/101/dispatches',
      '/repos/o/r/actions/workflows/101/runs',
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
