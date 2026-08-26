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
import { createRepo, listRepos } from './repo.ts'

describe('createRepo', () => {
  it.each([
    ['Alice', '/user/repos'],
    ['acme', '/orgs/acme/repos'],
  ])('routes owner %s to %s', async (owner, expected) => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        calls.push({ method: 'GET', path })
        return Promise.resolve({ login: 'alice' })
      },
      request: (method, path, body) => {
        calls.push({ method, path, body })
        return Promise.resolve({ name: 'new' })
      },
    }
    const body = { name: 'new' }

    expect(await createRepo(transport, owner, body)).toEqual({ name: 'new' })
    expect(calls).toEqual([
      { method: 'GET', path: '/user' },
      { method: 'POST', path: expected, body },
    ])
  })
})

describe('listRepos', () => {
  it.each([
    ['User', '/users/alice/repos'],
    ['Organization', '/orgs/alice/repos'],
  ])('routes a %s owner to %s', async (type, expected) => {
    const paths: string[] = []
    const transport: GitHubTransport = {
      get: (path) => {
        paths.push(path)
        return Promise.resolve(path === '/users/alice' ? { type } : [])
      },
      request: () => Promise.reject(new Error('unexpected request')),
    }

    expect(await listRepos(transport, 'alice', 5)).toEqual([])
    expect(paths).toEqual(['/users/alice', expected])
  })
})
