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

import type { Ctx, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { commitFiles, pathsOf } from './wire.ts'
import { commitList } from './store.ts'
import type { RepoRow } from './store.ts'
import { authedRoute, everywhere, fail, param, route, withRepo } from './http.ts'

// Files changed between two refs. The fake diffs nothing, so a comparison is
// answered from the commits recorded since the base, which is enough for
// "which files did the agent touch" and is what the graders ask.
async function compare(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const spec = param(ctx, 'basehead')
  const base = spec.includes('...') ? (spec.split('...')[0] ?? '') : ''
  const history = await commitList(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const known = new Set(history.map((c) => c.sha))
  // A base this repository has never heard of is an error, not an empty diff.
  // Answering "nothing changed" to a question about an unrelated commit is the
  // shape of wrongness that reads as success.
  if (base !== '' && !known.has(base) && base !== repo.defaultBranch) {
    return fail(404, 'No common ancestor between the two commits')
  }
  // `history` is newest first, so everything before the base is what came
  // after it in time. Walking past the base instead would collect the commits
  // the base already contains.
  const touched: string[] = []
  for (const commit of history) {
    if (base !== '' && commit.sha === base) break
    touched.push(...pathsOf(commit))
  }
  const files = commitFiles([...new Set(touched)], 'modified')
  return { status: 200, body: { status: 'ahead', files, commits: [] } }
}

export function compareRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/repos/:owner/:repo/compare/:basehead`, authedRoute(withRepo(compare))),
  ])
}
