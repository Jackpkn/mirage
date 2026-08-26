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
  return `/repos/${ref.owner}/${ref.repo}/issues${tail}`
}

function onlyIssue(value: unknown, number: number): unknown {
  if (value !== null && typeof value === 'object' && 'pull_request' in value) {
    throw new Error(`#${String(number)} is a pull request, not an issue`)
  }
  return value
}

export async function listIssues(
  transport: GitHubTransport,
  ref: RepoRef,
  params: Record<string, string>,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return githubPages(transport, path(ref), {
    params,
    limit,
    include: (row) => !('pull_request' in row),
  })
}

export async function getIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
): Promise<unknown> {
  return onlyIssue(await transport.get(path(ref, `/${String(number)}`)), number)
}

export function createIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request('POST', path(ref), body)
}

export async function editIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  await getIssue(transport, ref, number)
  return transport.request('PATCH', path(ref, `/${String(number)}`), body)
}

export async function commentIssue(
  transport: GitHubTransport,
  ref: RepoRef,
  number: number,
  body: string,
): Promise<unknown> {
  await getIssue(transport, ref, number)
  return transport.request('POST', path(ref, `/${String(number)}/comments`), { body })
}
