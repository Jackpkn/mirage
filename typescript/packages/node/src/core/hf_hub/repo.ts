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

import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { apiUrl, HfHubError, hubGet } from './client.ts'

/** The repository object: sha, lastModified, tags, gated, card data. */
export async function repoInfo(accessor: HfHubAccessor): Promise<Record<string, unknown>> {
  const url = apiUrl(accessor.endpoint, accessor.repoType, accessor.repoId, '')
  const data = await hubGet(accessor.token, url)
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/** The repository's branches, tags and conversion refs. */
export async function fetchRefs(accessor: HfHubAccessor): Promise<Record<string, unknown>> {
  const url = apiUrl(accessor.endpoint, accessor.repoType, accessor.repoId, '/refs')
  const data = await hubGet(accessor.token, url)
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/**
 * The commit the mount's revision currently points at.
 *
 * Read from the repo object rather than from /refs because the repo object
 * answers it for a tag and a commit-pinned mount too, where /refs only
 * enumerates branches.
 */
export async function headCommit(accessor: HfHubAccessor): Promise<string> {
  const info = await repoInfo(accessor)
  const sha = info.sha
  return typeof sha === 'string' ? sha : ''
}

/** What the Hub says is missing when a listing came back empty. */
export enum Absence {
  PRESENT = 'present',
  REPO = 'repo',
  REVISION = 'revision',
}

/** The endpoint whose url upstream names in its not-found messages. */
export function revisionUrl(accessor: HfHubAccessor): string {
  return apiUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    `/revision/${encodeURIComponent(accessor.revision)}`,
  )
}

/**
 * Why a listing came back empty, asked of the Hub directly.
 *
 * `fetchTree` folds 401/403/404 into an empty listing on purpose: a mount's
 * readdir over a repository it cannot see has to render an empty directory
 * rather than raise. A CLI verb wants the opposite, so it asks this on the
 * failure path only, which costs one request and only when something already
 * went wrong.
 *
 * The status cannot answer it. A missing repository, a missing revision and a
 * missing file are all 404, and only the Hub's `X-Error-Code` header tells
 * them apart; probed against the live Hub, not inferred.
 */
export async function classifyAbsence(accessor: HfHubAccessor): Promise<Absence> {
  try {
    await hubGet(accessor.token, revisionUrl(accessor))
  } catch (err) {
    if (err instanceof HfHubError) {
      if (err.errorCode === 'RepoNotFound') return Absence.REPO
      if (err.errorCode === 'RevisionNotFound') return Absence.REVISION
    }
    throw err
  }
  return Absence.PRESENT
}
