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

function actions(ref: RepoRef, tail: string): string {
  return `/repos/${ref.owner}/${ref.repo}/actions/${tail}`
}

export function listRuns(
  transport: GitHubTransport,
  ref: RepoRef,
  params: Record<string, string>,
  limit: number,
  workflow?: string,
): Promise<Record<string, unknown>[]> {
  const tail = workflow === undefined ? 'runs' : `workflows/${encodeURIComponent(workflow)}/runs`
  return githubPages(transport, actions(ref, tail), { params, limit, key: 'workflow_runs' })
}

export function getRun(transport: GitHubTransport, ref: RepoRef, runId: number): Promise<unknown> {
  return transport.get(actions(ref, `runs/${String(runId)}`))
}

export function rerun(
  transport: GitHubTransport,
  ref: RepoRef,
  runId: number,
  suffix: string,
  body?: unknown,
): Promise<unknown> {
  return transport.request('POST', actions(ref, `runs/${String(runId)}/${suffix}`), body)
}

export function rerunJob(
  transport: GitHubTransport,
  ref: RepoRef,
  jobId: number,
  debug: boolean,
): Promise<unknown> {
  return transport.request('POST', actions(ref, `jobs/${String(jobId)}/rerun`), {
    enable_debug_logging: debug,
  })
}

export function listWorkflows(
  transport: GitHubTransport,
  ref: RepoRef,
  limit: number,
  include?: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  return githubPages(transport, actions(ref, 'workflows'), {
    limit,
    key: 'workflows',
    ...(include === undefined ? {} : { include }),
  })
}

export function getWorkflow(
  transport: GitHubTransport,
  ref: RepoRef,
  workflow: string,
): Promise<unknown> {
  return transport.get(actions(ref, `workflows/${encodeURIComponent(workflow)}`))
}

export function dispatchWorkflow(
  transport: GitHubTransport,
  ref: RepoRef,
  workflow: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return transport.request(
    'POST',
    actions(ref, `workflows/${encodeURIComponent(workflow)}/dispatches`),
    body,
  )
}
