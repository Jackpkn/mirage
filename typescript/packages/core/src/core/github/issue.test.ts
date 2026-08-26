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
import { commentIssue, editIssue, getIssue } from './issue.ts'

describe('direct issue verbs', () => {
  it.each(['get', 'edit', 'comment'] as const)(
    'rejects a pull request number for %s',
    async (verb) => {
      const calls: { method: string; path: string }[] = []
      const transport: GitHubTransport = {
        get: (path) => {
          calls.push({ method: 'GET', path })
          return Promise.resolve({ number: 4, pull_request: { url: 'x' } })
        },
        request: (method, path) => {
          calls.push({ method, path })
          return Promise.resolve({})
        },
      }
      const ref = { owner: 'o', repo: 'r' }
      const operation =
        verb === 'get'
          ? getIssue(transport, ref, 4)
          : verb === 'edit'
            ? editIssue(transport, ref, 4, { state: 'closed' })
            : commentIssue(transport, ref, 4, 'no')

      await expect(operation).rejects.toThrow('pull request, not an issue')
      expect(calls).toEqual([{ method: 'GET', path: '/repos/o/r/issues/4' }])
    },
  )
})
