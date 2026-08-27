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

import type { KitRoute } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { blobSha, treeSha } from './wire.ts'
import { branchFor, branchNames, commitList, treeOfBranch } from './store.ts'
import type { RepoRow, Tree } from './store.ts'
import { authedRoute, everywhere, fail, jsonBodyOf, param, route, str, withRepo } from './http.ts'
import { recordCommit, writeFile } from './contents.ts'

async function blobBySha(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<Buffer | null> {
  for (const branch of await branchNames(db, tenant, repo)) {
    const files = await treeOfBranch(db, tenant, repo, branch)
    for (const data of files.values()) if (blobSha(data) === sha) return data
  }
  return null
}

async function stagedTree(db: C, tenant: string, sha: string): Promise<Tree | null> {
  const tree = await db.githubStagedTree.findUnique({ where: { tenant_sha: { tenant, sha } } })
  if (tree === null) return null
  const rows = await db.githubStagedEntry.findMany({
    where: { tenant, treeSha: sha },
    orderBy: { seq: 'asc' },
  })
  const out: Tree = new Map()
  for (const r of rows) out.set(r.path, Buffer.from(r.data))
  return out
}

// Build a tree from the default branch plus the caller's entries. A null sha is
// git's delete, `content` is the inline form, and a bare sha names a blob the
// caller wrote earlier.
const createTree = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const files = await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const entries = Array.isArray(body.tree) ? body.tree : []
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const path = String(entry.path ?? '').replace(/^\/+|\/+$/g, '')
    if (path === '') continue
    if ('sha' in entry && entry.sha === null) {
      files.delete(path)
    } else if (entry.content !== undefined && entry.content !== null) {
      files.set(path, Buffer.from(String(entry.content), 'utf8'))
    } else if (typeof entry.sha === 'string' && entry.sha !== '') {
      const blob = await blobBySha(ctx.db, ctx.tenant, repo, entry.sha)
      if (blob === null) return fail(422, `Tree entry ${path} has an unknown sha`)
      files.set(path, blob)
    }
  }
  const count = await ctx.db.githubStagedTree.count({
    where: { tenant: ctx.tenant, repo: repo.fullName },
  })
  const sha = treeSha(`${repo.fullName}:${String(count)}`)
  await ctx.db.githubStagedTree.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, sha, seq: count },
  })
  let seq = 0
  for (const [path, data] of files) {
    await ctx.db.githubStagedEntry.create({
      data: { tenant: ctx.tenant, treeSha: sha, path, data: new Uint8Array(data), seq },
    })
    seq += 1
  }
  return { status: 201, body: { sha, tree: [] } }
})

// The touched set is computed against the DEFAULT branch, which is what the
// python fake did and what a golden records, even when the commit is later
// pointed at another branch.
const createCommit = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const tree = str(body, 'tree')
  const staged = await stagedTree(ctx.db, ctx.tenant, tree)
  if (staged === null) return fail(422, 'Invalid request.\n\n"tree" is invalid.')
  const current = await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const touched = new Set<string>()
  for (const p of staged.keys()) if (!current.has(p)) touched.add(p)
  for (const p of current.keys()) if (!staged.has(p)) touched.add(p)
  for (const [p, d] of staged) {
    const was = current.get(p)
    if (was === undefined || !was.equals(d)) touched.add(p)
  }
  const message = str(body, 'message') === '' ? 'Update' : str(body, 'message')
  const commit = await recordCommit(
    ctx.db,
    ctx.tenant,
    repo,
    message,
    [...touched].sort(),
    repo.defaultBranch,
    tree,
  )
  return { status: 201, body: { sha: commit.sha, message, tree: { sha: tree } } }
})

// A branch starts as a copy of whatever the base sha resolves to, which is what
// a branch is: another name for one commit and every file reachable from it.
// Its own history starts there, so the two do not share future commits.
const createRef = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const ref = str(body, 'ref').replace(/^\/+|\/+$/g, '')
  if (!ref.startsWith('refs/heads/')) return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const name = ref.slice('refs/heads/'.length)
  if (name === '') return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (names.includes(name)) return fail(422, 'Reference already exists')
  const base = await branchFor(ctx.db, ctx.tenant, repo, str(body, 'sha'))
  if (base === null) return fail(422, 'Object does not exist')
  const files = await treeOfBranch(ctx.db, ctx.tenant, repo, base)
  let seq = 0
  for (const [path, data] of files) {
    await ctx.db.githubFile.create({
      data: {
        tenant: ctx.tenant,
        repo: repo.fullName,
        branch: name,
        path,
        data: new Uint8Array(data),
        seq,
      },
    })
    seq += 1
  }
  const head = await commitList(ctx.db, ctx.tenant, repo, name)
  return {
    status: 201,
    body: { ref: `refs/heads/${name}`, object: { sha: head[0]?.sha ?? '', type: 'commit' } },
  }
})

// Moving a branch is what makes a staged tree visible.
const updateRef = withRepo(async (ctx, repo) => {
  const ref = param(ctx, 'ref').replace(/^\/+|\/+$/g, '')
  const name = ref.startsWith('heads/') ? ref.slice('heads/'.length) : ''
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (name === '' || !names.includes(name)) return fail(422, 'Reference does not exist')
  const body = jsonBodyOf(ctx)
  const sha = str(body, 'sha')
  const commit = await ctx.db.githubCommit.findFirst({
    where: { tenant: ctx.tenant, repo: repo.fullName, sha },
  })
  if (commit === null || commit.treeSha === '') {
    return fail(422, 'Invalid request.\n\n"sha" is invalid.')
  }
  const staged = await stagedTree(ctx.db, ctx.tenant, commit.treeSha)
  if (staged === null) return fail(422, 'Invalid request.\n\n"sha" is invalid.')
  await ctx.db.githubFile.deleteMany({
    where: { tenant: ctx.tenant, repo: repo.fullName, branch: name },
  })
  for (const [path, data] of staged) {
    await writeFile(ctx.db, ctx.tenant, repo, name, path, data)
  }
  return { status: 200, body: { ref: `refs/${ref}`, object: { sha, type: 'commit' } } }
})

const gitCommit = withRepo(async (ctx, repo) => {
  const sha = param(ctx, 'sha')
  const row = await ctx.db.githubCommit.findFirst({
    where: { tenant: ctx.tenant, repo: repo.fullName, sha },
  })
  if (row === null) return fail(404, 'Not Found')
  return {
    status: 200,
    body: { sha, message: row.message, tree: { sha: row.treeSha } },
  }
})

const showRef = withRepo(async (ctx, repo) => {
  const ref = param(ctx, 'ref').replace(/^\/+|\/+$/g, '')
  const name = ref.startsWith('heads/') ? ref.slice('heads/'.length) : ref
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (!names.includes(name)) return fail(404, 'Not Found')
  const head = await commitList(ctx.db, ctx.tenant, repo, name)
  return {
    status: 200,
    body: { ref: `refs/heads/${name}`, object: { sha: head[0]?.sha ?? '', type: 'commit' } },
  }
})

export function gitRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('POST', `${p}/repos/:owner/:repo/git/trees`, authedRoute(createTree), { write: true }),
    route<C>('POST', `${p}/repos/:owner/:repo/git/commits`, authedRoute(createCommit), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/commits/:sha`, authedRoute(gitCommit)),
    route<C>('POST', `${p}/repos/:owner/:repo/git/refs`, authedRoute(createRef), { write: true }),
    route<C>('PATCH', `${p}/repos/:owner/:repo/git/refs/*ref`, authedRoute(updateRef), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/ref/*ref`, authedRoute(showRef)),
    route<C>('GET', `${p}/repos/:owner/:repo/git/refs/*ref`, authedRoute(showRef)),
  ])
}
