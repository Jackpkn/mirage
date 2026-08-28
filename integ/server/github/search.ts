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

import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { blobSha } from './wire.ts'
import { allRepos, metaOf, repoByName, searchTree, treeOfBranch } from './store.ts'
import type { RepoRow } from './store.ts'
import { authedRoute, everywhere, fail, route } from './http.ts'
import { repoJson } from './repos.ts'

const TOKEN_RE = /[A-Za-z0-9_]+/g

function starsOf(repo: RepoRow): number {
  const value = metaOf(repo).stargazers_count
  return typeof value === 'number' ? value : 0
}

function descriptionOf(repo: RepoRow): string {
  const value = metaOf(repo).description
  return typeof value === 'string' ? value : ''
}

// Qualifiers (`user:x`, `in:name`) are dropped rather than honoured; what is
// left is matched against the name and the description, because a repository
// is found by what it says it does at least as often as by what it is called.
// Terms OR together rather than AND, which is looser than GitHub and errs
// towards showing a caller the row it is looking for; a hyphenated term also
// matches its parts.
function repoTerms(query: string): string[] {
  const out: string[] = []
  for (const word of query.split(/\s+/).filter((w) => w !== '')) {
    if (word.includes(':')) continue
    out.push(word)
    for (const part of word.split(/[-_]/)) if (part.length > 2) out.push(part)
  }
  return out
}

// Substring rather than GitHub's own qualifier grammar, which nothing here
// parses. It is here at all because the alternative is a 404, and a caller
// reads that as "no such repository": an agent looking for the fork it just
// made would conclude it had not made one.
async function searchRepos(ctx: Ctx<C>): Promise<Reply> {
  const query = (ctx.query.get('q') ?? '').toLowerCase()
  const terms = repoTerms(query)
  const repos = await allRepos(ctx.db, ctx.tenant)
  const matched = repos.filter((repo) => {
    const haystack = `${repo.fullName} ${descriptionOf(repo)}`.toLowerCase()
    return terms.length === 0 || terms.some((t) => haystack.includes(t))
  })
  // GitHub's default is relevance, which is not modelled; `sort=stars` is,
  // because a task that asks for "the most starred" is asking for exactly
  // this ordering.
  if (ctx.query.get('sort') === 'stars') {
    const sign = (ctx.query.get('order') ?? 'desc') === 'asc' ? 1 : -1
    matched.sort((a, b) => sign * (starsOf(a) - starsOf(b)))
  } else {
    matched.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0))
  }
  const items = matched.map(repoJson)
  return { status: 200, body: { total_count: items.length, incomplete_results: false, items } }
}

// Code search reads only the default branch, which is where the fake builds
// its term index, and it needs a `repo:` qualifier: the live API refuses a
// query that names no scope, and answering one over everything would let a
// caller believe a global index exists.
async function searchCode(ctx: Ctx<C>): Promise<Reply> {
  const query = ctx.query.get('q') ?? ''
  const terms: string[] = []
  let target: string | null = null
  let pathFilter: string | null = null
  for (const word of query.split(/\s+/).filter((w) => w !== '')) {
    if (word.startsWith('repo:')) target = word.slice('repo:'.length)
    else if (word.startsWith('path:')) pathFilter = word.slice('path:'.length)
    else terms.push(...(word.toLowerCase().match(TOKEN_RE) ?? []))
  }
  if (target === null) {
    return fail(422, 'Must include at least one user, organization, or repository')
  }
  const repo = await repoByName(ctx.db, ctx.tenant, target)
  if (repo === null) return fail(404, 'Not Found')
  const files = await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const items: JsonValue[] = []
  for (const path of searchTree(files, terms, pathFilter)) {
    const data = files.get(path)
    if (data === undefined) continue
    items.push({
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      sha: blobSha(data),
      score: 1.0,
      repository: { name: repo.name, full_name: repo.fullName },
    })
  }
  return { status: 200, body: { total_count: items.length, incomplete_results: false, items } }
}

export function searchRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/search/code`, authedRoute(searchCode)),
    route<C>('GET', `${p}/search/repositories`, authedRoute(searchRepos)),
  ])
}
