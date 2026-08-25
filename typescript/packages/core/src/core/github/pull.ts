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

import type { GitHubTransport } from './client.ts'
import { githubPages } from './paginate.ts'
import type { RepoRef } from './repo.ts'

function path(ref: RepoRef, tail = ''): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls${tail}`
}

export function listPulls(
  transport: GitHubTransport,
  ref: RepoRef,
  params: Record<string, string>,
  limit: number,
  include?: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  return githubPages(transport, path(ref), {
    params,
    limit,
    ...(include === undefined ? {} : { include }),
  })
}

export function getPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<unknown> {
  return transport.get(path(ref, `/${String(number)}`))
}

export function createPull(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('POST', path(ref), body)
}

export function editPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('PATCH', path(ref, `/${String(number)}`), body)
}

export function mergePull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request(
    'PUT',
    path(ref, `/${String(number)}/merge`),
    Object.keys(body).length === 0 ? undefined : body,
  )
}

export async function commentPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: string,
): Promise<unknown> {
  await getPull(transport, ref, number)
  return transport.request(
    'POST',
    `/repos/${ref.owner}/${ref.repo}/issues/${String(number)}/comments`,
    { body },
  )
}

export async function diffPull(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<string> {
  const value = await transport.request(
    'GET',
    path(ref, `/${String(number)}`),
    undefined,
    undefined,
    { Accept: 'application/vnd.github.v3.diff' },
  )
  return typeof value === 'string' ? value : ''
}

export async function pullChecks(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const pull = (await getPull(transport, ref, number)) as { head?: { sha?: unknown } }
  const sha = pull.head?.sha
  if (typeof sha !== 'string') return []
  return githubPages(transport, `/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs`, {
    limit,
    key: 'check_runs',
  })
}
