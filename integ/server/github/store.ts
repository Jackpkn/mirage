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

import { tenantWhere } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { SEARCH_SIZE_LIMIT, config } from './config.ts'
import type { C } from './config.ts'
import { blobSha, commitSha, rootCommit, treeSha } from './wire.ts'
import type { CommitRow } from './wire.ts'

export interface RepoRow {
  fullName: string
  owner: string
  name: string
  defaultBranch: string
  metaJson: string
  truncated: boolean
  sourceDir: string
  sourceBranch: string
  seq: number
}

export type Tree = Map<string, Buffer>

export function scope(tenant: string): Record<string, JsonValue> {
  return tenantWhere(tenant, config.tenantKind)
}

export async function repoByName(db: C, tenant: string, fullName: string): Promise<RepoRow | null> {
  return (await db.githubRepo.findUnique({
    where: { tenant_fullName: { tenant, fullName } },
  })) as RepoRow | null
}

export async function allRepos(db: C, tenant: string): Promise<RepoRow[]> {
  return (await db.githubRepo.findMany({
    where: scope(tenant),
    orderBy: { seq: 'asc' },
  })) as RepoRow[]
}

// Issues and pull requests share one counter, because on GitHub they share one
// number space: a repository with issue 1 numbers its first pull request 2.
export async function nextNumber(db: C, tenant: string, repo: RepoRow): Promise<number> {
  const where = { ...scope(tenant), repo: repo.fullName }
  const issue = await db.githubIssue.findFirst({ where, orderBy: { number: 'desc' } })
  const pull = await db.githubPull.findFirst({ where, orderBy: { number: 'desc' } })
  return Math.max(issue?.number ?? 0, pull?.number ?? 0) + 1
}

export function metaOf(repo: RepoRow): Record<string, JsonValue> {
  const parsed = JSON.parse(repo.metaJson) as JsonValue
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

// Branches, the default one first and the rest in name order.
export async function branchNames(db: C, tenant: string, repo: RepoRow): Promise<string[]> {
  const rows = await db.githubBranch.findMany({
    where: { ...scope(tenant), repo: repo.fullName },
    select: { name: true },
  })
  const seen = new Set(rows.map((r) => r.name))
  // The default branch is prepended whether or not a row exists for it, which
  // is what the fake this replaces did: renaming a repository's default branch
  // set the name without creating the branch, and the listing still led with
  // it.
  seen.add(repo.defaultBranch)
  const rest = [...seen].filter((b) => b !== repo.defaultBranch).sort()
  return [repo.defaultBranch, ...rest]
}

// A branch exists once it is recorded, independently of whether anything is on
// it. Idempotent, because every path that can reach a branch (seeding, repo
// creation, a fork, a new ref) may be reached twice for the same name.
export async function addBranch(
  db: C,
  tenant: string,
  fullName: string,
  name: string,
): Promise<void> {
  const count = await db.githubBranch.count({ where: { ...scope(tenant), repo: fullName } })
  await db.githubBranch.upsert({
    where: { tenant_repo_name: { tenant, repo: fullName, name } },
    update: {},
    create: { tenant, repo: fullName, name, seq: count },
  })
}

export async function treeOfBranch(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<Tree> {
  const rows = await db.githubFile.findMany({
    where: { ...scope(tenant), repo: repo.fullName, branch },
    orderBy: { seq: 'asc' },
  })
  const out: Tree = new Map()
  for (const r of rows) out.set(r.path, Buffer.from(r.data))
  return out
}

// A ref is a branch name, HEAD, the empty string, or a commit sha belonging to
// one branch's history. A fully qualified spelling names the same branch: tool
// schemas advertise `refs/heads/main` and the live API accepts it on every
// ref-taking parameter.
export async function branchFor(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<string | null> {
  if (ref === null || ref === '' || ref === 'HEAD') return repo.defaultBranch
  let name = ref
  for (const qualifier of ['refs/heads/', 'heads/']) {
    if (name.startsWith(qualifier)) {
      name = name.slice(qualifier.length)
      break
    }
  }
  const branches = await branchNames(db, tenant, repo)
  if (branches.includes(name)) return name
  for (const branch of branches) {
    const list = await commitList(db, tenant, repo, branch)
    if (list.some((c) => c.sha === ref)) return branch
  }
  return null
}

export async function treeOf(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<Tree | null> {
  const branch = await branchFor(db, tenant, repo, ref)
  return branch === null ? null : await treeOfBranch(db, tenant, repo, branch)
}

// One branch's commits, newest first, with a synthetic root derived from the
// branch's CONTENT rather than the repository's name, so that a mirror of a
// repository has the same root sha as its source. Two branches differ here
// exactly when their trees differ.
export async function commitList(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<CommitRow[]> {
  const tree = await treeOfBranch(db, tenant, repo, branch)
  const pairs: Array<[string, string]> = [...tree.entries()].map(([p, d]) => [p, blobSha(d)])
  const written = (await db.githubCommit.findMany({
    where: { ...scope(tenant), repo: repo.fullName, branch },
    orderBy: { seq: 'asc' },
  })) as CommitRow[]
  return [...[...written].reverse(), rootCommit(pairs)]
}

export function directoriesOf(files: Tree): Set<string> {
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
  }
  return dirs
}

export async function submodulesOf(db: C, tenant: string, repo: RepoRow): Promise<string[]> {
  const rows = await db.githubSubmodule.findMany({
    where: { ...scope(tenant), repo: repo.fullName },
    orderBy: { path: 'asc' },
  })
  return rows.map((r) => r.path)
}

// Recursive tree entries, optionally rooted at a subdirectory: blobs carry a
// size, trees carry none, and a gitlink is mode 160000 with no blob behind it.
// One git tree entry. Typed rather than JsonValue because the tree route reads
// `path` back to filter a truncated listing, and a caller that has to cast for
// that is a caller the shape was never declared to.
// A blob entry carries a size and a tree or gitlink entry carries none, so the
// two are spelled as a union rather than as one shape with an optional field:
// an optional property widens to `| undefined`, which is not a JSON value, and
// the whole entry then stops being one.
export type TreeItem =
  | { path: string; mode: string; type: string; sha: string }
  | { path: string; mode: string; type: string; sha: string; size: number }

export function treeItems(files: Tree, submodules: string[], at = ''): TreeItem[] {
  const prefix = at === '' ? '' : `${at}/`
  const items: TreeItem[] = []
  for (const path of [...directoriesOf(files)].sort()) {
    if (!path.startsWith(prefix) || path === at) continue
    items.push({
      path: path.slice(prefix.length),
      mode: '040000',
      type: 'tree',
      sha: treeSha(path),
    })
  }
  for (const path of [...files.keys()].sort()) {
    if (!path.startsWith(prefix)) continue
    const data = files.get(path) ?? Buffer.alloc(0)
    items.push({
      path: path.slice(prefix.length),
      mode: '100644',
      type: 'blob',
      sha: blobSha(data),
      size: data.length,
    })
  }
  for (const path of [...submodules].sort()) {
    if (!path.startsWith(prefix)) continue
    items.push({
      path: path.slice(prefix.length),
      mode: '160000',
      type: 'commit',
      sha: commitSha(path),
    })
  }
  items.sort((a, b) => (a.path < b.path ? -1 : 1))
  return items
}

// The python fake kept a term -> paths index and rebuilt it on every write.
// Scanning the default branch per query answers the same thing for a
// fixture-sized repository without a second structure that a write can forget
// to update. The size limit is kept because it is observable: a file at or
// over it is not searchable.
const TOKEN_RE = /[A-Za-z0-9_]+/g

export function searchTree(files: Tree, terms: string[], pathFilter: string | null): string[] {
  if (terms.length === 0) return []
  // Every term must hit, so the result is the intersection: seed it with the
  // first term's hits and narrow with each of the rest.
  let matched = new Set<string>()
  let first = true
  for (const term of terms) {
    const hits = new Set<string>()
    for (const [path, data] of files) {
      if (data.length >= SEARCH_SIZE_LIMIT) continue
      const text = data.toString('utf8').toLowerCase()
      const tokens = text.match(TOKEN_RE)
      if (tokens !== null && tokens.includes(term)) hits.add(path)
    }
    if (first) {
      matched = hits
      first = false
    } else {
      const kept = new Set<string>()
      for (const path of matched) if (hits.has(path)) kept.add(path)
      matched = kept
    }
    if (matched.size === 0) return []
  }
  let found = [...matched].sort()
  if (pathFilter !== null && pathFilter !== '') {
    const at = pathFilter.replace(/^\/+|\/+$/g, '')
    found = found.filter((p) => p === at || p.startsWith(`${at}/`))
  }
  return found
}
