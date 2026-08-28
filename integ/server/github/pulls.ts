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
import { API_PREFIXES, DEFAULT_LOGIN } from './config.ts'
import type { C } from './config.ts'
import { commitSha } from './wire.ts'
import { nextNumber, scope } from './store.ts'
import type { RepoRow } from './store.ts'
import {
  authedRoute,
  everywhere,
  fail,
  jsonBodyOf,
  numberParam,
  pagedReply,
  route,
  str,
  withRepo,
} from './http.ts'

const CREATED_AT = '2026-01-01T00:00:00Z'
const EDITED_AT = '2026-01-01T00:02:00Z'
const MERGED_AT = '2026-01-01T00:03:00Z'

// The one diff the fake serves, for a caller that asks for a pull request as
// `application/vnd.github.diff` rather than as JSON.
const SAMPLE_DIFF =
  'diff --git a/README.md b/README.md\n' +
  '--- a/README.md\n+++ b/README.md\n' +
  '@@ -1 +1,2 @@\n # repo-v1\n+change\n'

export interface PullRow {
  number: number
  title: string
  body: string
  state: string
  user: string
  head: string
  base: string
  draft: boolean
  merged: boolean
  headSha: string
  createdAt: string
  updatedAt: string
}

// The counts are fixed rather than derived from the branch: nothing in the
// fake diffs two trees, and a caller that renders them wants a stable number.
export function pullJson(repo: RepoRow, row: PullRow): JsonValue {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    draft: row.draft,
    user: { login: row.user },
    labels: [],
    base: { ref: row.base },
    head: { ref: row.head, sha: row.headSha },
    mergeable: true,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    merged_at: row.merged ? MERGED_AT : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${String(row.number)}`,
  }
}

export async function pullRow(
  db: C,
  tenant: string,
  repo: RepoRow,
  number: number,
): Promise<PullRow | null> {
  return (await db.githubPull.findFirst({
    where: { ...scope(tenant), repo: repo.fullName, number },
  })) as PullRow | null
}

async function found(ctx: Ctx<C>, repo: RepoRow): Promise<PullRow | null> {
  const number = numberParam(ctx)
  return number === null ? null : await pullRow(ctx.db, ctx.tenant, repo, number)
}

async function listPulls(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const rows = (await ctx.db.githubPull.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'desc' },
  })) as PullRow[]
  const wanted = ctx.query.get('state') ?? 'open'
  let kept = rows.filter((r) => wanted === 'all' || r.state === wanted)
  const base = ctx.query.get('base') ?? ''
  const head = ctx.query.get('head') ?? ''
  if (base !== '') kept = kept.filter((r) => r.base === base)
  if (head !== '') kept = kept.filter((r) => r.head === head)
  return pagedReply(
    ctx,
    kept.map((r) => pullJson(repo, r)),
  )
}

async function createPull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const body = jsonBodyOf(ctx)
  const title = str(body, 'title')
  const head = str(body, 'head')
  const base = str(body, 'base')
  if (title === '' || head === '' || base === '') return fail(422, 'Validation Failed')
  const number = await nextNumber(ctx.db, ctx.tenant, repo)
  const row: PullRow = {
    number,
    title,
    body: str(body, 'body'),
    state: 'open',
    user: DEFAULT_LOGIN,
    head,
    base,
    draft: body.draft === true,
    merged: false,
    headSha: commitSha(head),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
  await ctx.db.githubPull.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, ...row, seq: number },
  })
  return { status: 201, body: pullJson(repo, row) }
}

async function getPull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  if ((ctx.headers.accept ?? '').includes('diff')) {
    return {
      status: 200,
      body: Buffer.from(SAMPLE_DIFF),
      headers: { 'Content-Type': 'text/plain' },
    }
  }
  return { status: 200, body: pullJson(repo, row) }
}

async function editPull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const body = jsonBodyOf(ctx)
  const next: PullRow = { ...row, updatedAt: EDITED_AT }
  if ('title' in body) next.title = str(body, 'title')
  if ('body' in body) next.body = str(body, 'body')
  if ('state' in body) next.state = str(body, 'state')
  if ('base' in body) next.base = str(body, 'base')
  await ctx.db.githubPull.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number: row.number },
    data: next,
  })
  return { status: 200, body: pullJson(repo, next) }
}

// A merge takes an optional expected head sha, and refuses when it does not
// match: that is how the vendor reports a branch that moved under the caller.
async function mergePull(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const row = await found(ctx, repo)
  if (row === null) return fail(404, 'Not Found')
  const expected = str(jsonBodyOf(ctx), 'sha')
  if (expected !== '' && expected !== row.headSha) return fail(409, 'Head branch was modified')
  await ctx.db.githubPull.updateMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName, number: row.number },
    data: { state: 'closed', merged: true },
  })
  return {
    status: 200,
    body: {
      sha: commitSha('merge'),
      merged: true,
      message: 'Pull Request successfully merged',
    },
  }
}

export function pullRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/repos/:owner/:repo/pulls`, authedRoute(withRepo(listPulls))),
    route<C>('POST', `${p}/repos/:owner/:repo/pulls`, authedRoute(withRepo(createPull)), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/pulls/:number`, authedRoute(withRepo(getPull))),
    route<C>('PATCH', `${p}/repos/:owner/:repo/pulls/:number`, authedRoute(withRepo(editPull)), {
      write: true,
    }),
    route<C>(
      'PUT',
      `${p}/repos/:owner/:repo/pulls/:number/merge`,
      authedRoute(withRepo(mergePull)),
      {
        write: true,
      },
    ),
  ])
}
