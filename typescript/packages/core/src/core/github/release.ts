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

import { GitHubApiError, type GitHubTransport } from './client.ts'
import { githubPages } from './paginate.ts'
import type { RepoRef } from './repo.ts'

function path(ref: RepoRef, tail = ''): string {
  return `/repos/${ref.owner}/${ref.repo}/releases${tail}`
}

export function listReleases(
  transport: GitHubTransport,
  ref: RepoRef,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return githubPages(transport, path(ref), { limit })
}

export function getRelease(
  transport: GitHubTransport,
  ref: RepoRef,
  tag: string,
): Promise<unknown> {
  return transport.get(path(ref, `/tags/${encodeURIComponent(tag)}`))
}

export async function getLatestRelease(transport: GitHubTransport, ref: RepoRef): Promise<unknown> {
  try {
    return await transport.get(path(ref, '/latest'))
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null
    throw err
  }
}

export function createRelease(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('POST', path(ref), body)
}
