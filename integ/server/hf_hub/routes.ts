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

import { rangeReply, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import {
  DEFAULT_LIMIT,
  DEFAULT_REVISION,
  KINDS,
  MAX_LIMIT,
  MAX_LIMIT_EXPANDED,
  type C,
} from './config.ts'
import {
  blobAt,
  blobsAt,
  commitChanges,
  commitTime,
  createRepo,
  headSha,
  refsOf,
  reposOfKind,
  repoOf,
  resolveRevision,
  type Change,
} from './store.ts'
import { cardTags, parseCard } from './card.ts'
import {
  dirRow,
  entryNotFound,
  hubError,
  repoId,
  repoKey,
  repoNotFound,
  repoUrl,
  revisionNotFound,
  treeRow,
  unauthorized,
  type Blob as HfBlobRow,
  type Repo,
} from './wire.ts'

const DEC = new TextDecoder()

function authed(ctx: Ctx<C>): boolean {
  const raw = ctx.headers.authorization
  const one = Array.isArray(raw) ? raw[0] : raw
  return one !== undefined && one.startsWith('Bearer ') && one.length > 'Bearer '.length
}

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function str(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** The origin this request arrived on, so links point back at the fake. */
function origin(ctx: Ctx<C>): string {
  return `${ctx.url.protocol}//${ctx.url.host}`
}

interface Located {
  repo: Repo
  key: string
}

// A repo id is one segment or two. The Hub resolves the bare form against the
// authenticated user's own namespace, which is what `hf repo create widget`
// then `hf download widget` produces, so both spellings have to route. Segment
// count disambiguates them: `:ns/:name` cannot match a single segment.
function namespaceOf(ctx: Ctx<C>): string {
  return ctx.params.ns ?? ctx.tenant
}

async function locate(ctx: Ctx<C>): Promise<Located | Reply> {
  const kind = ctx.params.kind ?? ''
  if (!KINDS.includes(kind)) return repoNotFound()
  const namespace = namespaceOf(ctx)
  const name = ctx.params.name ?? ''
  const repo = await repoOf(ctx.db, ctx.tenant, kind, namespace, name)
  if (repo === null) return repoNotFound()
  return { repo, key: repoKey(kind, namespace, name) }
}

function isReply(v: Located | Reply): v is Reply {
  return 'status' in v
}

// ------------------------------------------------------------------ search

// Upstream's sort keys, verbatim (`ModelSort_T`): a client passes one of
// these five and nothing else, so an unknown one is ignored rather than
// guessed at, which is what the Hub does.
const SORT_KEYS: Record<string, (r: Ranked) => number | string> = {
  downloads: (r) => r.repo.downloads,
  likes: (r) => r.repo.likes,
  created_at: (r) => r.repo.createdAt,
  last_modified: (r) => r.lastModified,
  trending_score: (r) => r.repo.likes,
}

interface Ranked {
  repo: Repo
  sha: string
  blobs: HfBlobRow[]
  lastModified: string
  tags: string[]
}

/**
 * List or search repositories of one kind.
 *
 * Matching is deliberately naive, a case-insensitive substring over the id,
 * because the Hub's own relevance ranking is not reproducible and pretending
 * otherwise would bake a fiction into the goldens. What IS aligned is the
 * part a client breaks on: the parameter names (`search`, `author`, `filter`,
 * `sort`, `direction`, `limit`, `full`), the five legal sort keys, and the
 * shape of each row.
 *
 * A row is trimmed unless `full` says otherwise, and `expand` names
 * individual properties instead. A row always carries its id, which is the
 * one field no `expand` can remove.
 */
async function listRepos(kind: string, ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const search = (ctx.query.get('search') ?? '').toLowerCase()
  const author = ctx.query.get('author') ?? ''
  const filters = ctx.query.getAll('filter')
  const sort = ctx.query.get('sort') ?? ''
  const direction = ctx.query.get('direction') ?? ''
  const rawLimit = ctx.query.get('limit')
  const expand = ctx.query.getAll('expand')
  // `full` is not simply off by default. Upstream states the rule on
  // `list_models` itself: it "is set to `True` by default when using a
  // filter", so a bare listing is trimmed and `filter` is the one parameter
  // that flips it. `search` and `sort` do not.
  const rawFull = ctx.query.get('full')
  const full = rawFull === null ? filters.length > 0 : truthy(rawFull)

  const ranked: Ranked[] = []
  for (const repo of await reposOfKind(ctx.db, ctx.tenant, kind)) {
    if (author !== '' && repo.namespace !== author) continue
    if (search !== '' && !repoId(repo).toLowerCase().includes(search)) continue
    const key = repoKey(repo.kind, repo.namespace, repo.name)
    const sha = await headSha(ctx.db, ctx.tenant, key)
    const blobs = sha === '' ? [] : await blobsAt(ctx.db, ctx.tenant, key, sha)
    const readme = blobs.find((b) => b.path === 'README.md')
    const tags = cardTags(
      readme === undefined ? {} : parseCard(Buffer.from(readme.content).toString('utf8')),
      repo.kind,
    )
    // Every filter must match, which is the Hub's rule: `?filter=a&filter=b`
    // narrows rather than widens.
    if (!filters.every((f) => tags.includes(f))) continue
    const when = await commitTime(ctx.db, ctx.tenant, key, sha)
    ranked.push({ repo, sha, blobs, lastModified: when === '' ? repo.createdAt : when, tags })
  }

  const key = SORT_KEYS[sort]
  if (key !== undefined) {
    ranked.sort((a, b) => {
      const [x, y] = [key(a), key(b)]
      return x < y ? -1 : x > y ? 1 : 0
    })
    // The Hub defaults to descending for a named sort, and -1 is the only
    // spelling it accepts for the other direction.
    if (direction !== '1') ranked.reverse()
  }

  const limit = rawLimit === null ? ranked.length : Math.max(0, Number(rawLimit) || 0)
  const rows = ranked.slice(0, limit).map((r) => {
    const body = obj(repoBody(r.repo, r.sha, r.blobs, r.lastModified))
    // `expand` wins outright rather than combining with `full`, and a call
    // carrying both is answered rather than refused. Two different rules are
    // easy to conflate here: huggingface_hub raises ValueError client-side
    // ("`expand` cannot be used if `full` is passed"), but the SERVER does
    // not, and this fake is the server. Probed:
    // `GET /api/models?limit=2&full=1&expand=likes` answers 200 with the
    // expanded shape, so refusing it would be the divergence.
    if (expand.length > 0) {
      const out: Record<string, JsonValue> = { id: body.id ?? '' }
      for (const name of expand) if (body[name] !== undefined) out[name] = body[name]
      return out
    }
    return full ? body : trimmed(body)
  })
  return { status: 200, body: rows }
}

// The Hub's non-`full` row. It is not "the whole object minus siblings": it
// is a short list the API commits to, and a client that asked for a listing
// rather than an info call gets exactly this.
function trimmed(body: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const k of [
    'id',
    'modelId',
    'author',
    'sha',
    'private',
    'gated',
    'disabled',
    'createdAt',
    'lastModified',
    'downloads',
    'likes',
    'tags',
    'pipeline_tag',
    'library_name',
  ]) {
    if (body[k] !== undefined) out[k] = body[k]
  }
  return out
}

// ---------------------------------------------------------------- repo info

async function repoInfo(ctx: Ctx<C>): Promise<Reply> {
  const found = await locate(ctx)
  if (isReply(found)) return found
  const { repo, key } = found
  const revision = ctx.params.rev ?? DEFAULT_REVISION
  const sha = await resolveRevision(ctx.db, ctx.tenant, key, revision)
  if (sha === null) return revisionNotFound(revision)
  const blobs = await blobsAt(ctx.db, ctx.tenant, key, sha)
  const when = await commitTime(ctx.db, ctx.tenant, key, sha)
  return { status: 200, body: repoBody(repo, sha, blobs, when === '' ? repo.createdAt : when) }
}

/**
 * One repository as the Hub renders it, for both the info and list routes.
 *
 * `cardData` is parsed out of README.md rather than stored, because a Hub
 * card IS that file: two copies of `license` could disagree, and the card is
 * the one a human edits. `tags` are the Hub's facets derived from it, NOT
 * git tags, which live at /refs; the two were conflated here, so
 * `hf repo tag create v1` used to surface as a facet on the model object.
 */
function repoBody(repo: Repo, sha: string, blobs: HfBlobRow[], lastModified: string): JsonValue {
  const readme = blobs.find((b) => b.path === 'README.md')
  const card = readme === undefined ? {} : parseCard(Buffer.from(readme.content).toString('utf8'))
  const models = repo.kind === 'models'
  return {
    id: repoId(repo),
    // The Hub renders the id twice, once bare and once under the kind's own
    // key, and clients read either.
    modelId: models ? repoId(repo) : null,
    author: repo.namespace,
    sha,
    private: repo.private,
    // "" is the Hub's "not gated"; the other two values name which flavour of
    // gating applies, so this is not a boolean.
    gated: repo.gated === '' ? false : repo.gated,
    disabled: false,
    createdAt: repo.createdAt,
    lastModified,
    downloads: repo.downloads,
    likes: repo.likes,
    tags: cardTags(card, repo.kind),
    cardData: card,
    ...(models
      ? {
          pipeline_tag: card.pipeline_tag ?? null,
          library_name: card.library_name ?? null,
        }
      : {}),
    siblings: blobs.map((b) => ({ rfilename: b.path })),
    ...(repo.sdk !== null ? { sdk: repo.sdk } : {}),
  }
}

async function refs(ctx: Ctx<C>): Promise<Reply> {
  const found = await locate(ctx)
  if (isReply(found)) return found
  const rows = await refsOf(ctx.db, ctx.tenant, found.key)
  return {
    status: 200,
    body: {
      branches: rows
        .filter((r) => r.refType === 'branch')
        .map((r) => ({ name: r.name, ref: `refs/heads/${r.name}`, targetCommit: r.sha })),
      tags: rows
        .filter((r) => r.refType === 'tag')
        .map((r) => ({ name: r.name, ref: `refs/tags/${r.name}`, targetCommit: r.sha })),
      converts: [],
    },
  }
}

// -------------------------------------------------------------------- tree

/**
 * One page of a listing, with the Hub's cursor in a `Link` header.
 *
 * The cursor is the index of the next row, base64'd the way the Hub's own is
 * opaque. Paging by index rather than by path is only safe because the page is
 * cut from one ordered snapshot; a fake that re-queried per page would skip a
 * row that a concurrent write inserted, and the kit's write queue is what makes
 * that impossible here.
 */
function pageOf(rows: JsonValue[], cursorRaw: string | null, limit: number, url: URL): Reply {
  const start = cursorRaw === null ? 0 : Number(Buffer.from(cursorRaw, 'base64').toString('utf8'))
  const from = Number.isFinite(start) && start > 0 ? start : 0
  const page = rows.slice(from, from + limit)
  const next = from + limit
  const headers: Record<string, string> = {}
  if (next < rows.length) {
    const cursor = Buffer.from(String(next), 'utf8').toString('base64')
    const link = new URL(url.toString())
    link.searchParams.set('cursor', cursor)
    headers.Link = `<${link.toString()}>; rel="next"`
  }
  return { status: 200, body: page, headers }
}

/**
 * The directories implied by a set of file paths.
 *
 * git stores no directory objects, so the Hub synthesizes a `directory` row for
 * every path component that has a file under it. A recursive listing carries
 * them too, which is what lets a client tell an empty prefix from a missing one.
 */
function impliedDirs(paths: string[], under: string): Set<string> {
  const dirs = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/')
      if (dir !== '' && dir.startsWith(under)) dirs.add(dir)
    }
  }
  return dirs
}

// The vendor's own client sends PYTHON bools: `list_repo_tree(recursive=True)`
// reaches the wire as `?recursive=True`, capital T, because requests stringifies
// the bool. A `=== 'true'` test reads that as false, so a recursive listing came
// back one level deep and `hf repo-files delete '<dir>/*'` matched nothing and
// reported "No files have been modified since last commit" instead of deleting.
// Probed against huggingface_hub 0.35.3.
function truthy(value: string | null): boolean {
  return value !== null && ['true', '1'].includes(value.toLowerCase())
}

async function tree(ctx: Ctx<C>): Promise<Reply> {
  const found = await locate(ctx)
  if (isReply(found)) return found
  const { key } = found
  const revision = ctx.params.rev ?? DEFAULT_REVISION
  const sha = await resolveRevision(ctx.db, ctx.tenant, key, revision)
  if (sha === null) return revisionNotFound(revision)

  const expand = truthy(ctx.query.get('expand'))
  const recursive = truthy(ctx.query.get('recursive'))
  const rawLimit = ctx.query.get('limit')
  const cap = expand ? MAX_LIMIT_EXPANDED : MAX_LIMIT
  let limit = DEFAULT_LIMIT
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit)
    if (!Number.isFinite(n) || n < 1 || n > cap) {
      // The real Hub refuses an oversized limit rather than clamping, and
      // refuses a SMALLER one under expand=true than without it. The client's
      // adaptive walk is built on exactly that, so clamping here would hide
      // the behaviour it is compensating for.
      return hubError(400, 'BadRequest', 'Invalid limit for index tree pagination')
    }
    limit = n
  }

  const prefix = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '')
  const under = prefix === '' ? '' : `${prefix}/`
  const blobs = (await blobsAt(ctx.db, ctx.tenant, key, sha)).filter((b) =>
    prefix === '' ? true : b.path.startsWith(under),
  )
  const kept = recursive ? blobs : blobs.filter((b) => !b.path.slice(under.length).includes('/'))
  const dirs = [
    ...impliedDirs(
      blobs.map((b) => b.path),
      under,
    ),
  ]
    .filter((d) => (recursive ? true : !d.slice(under.length).includes('/')))
    .sort()
  const date = blobs[0]?.lastModified ?? ''
  const rows: JsonValue[] = [
    ...dirs.map((d) => dirRow(d, expand, sha, date)),
    ...kept.map((b) => treeRow(b, expand)),
  ]
  return pageOf(rows, ctx.query.get('cursor'), limit, ctx.url)
}

// ----------------------------------------------------------------- resolve

async function resolve(ctx: Ctx<C>): Promise<Reply> {
  const kind = ctx.params.kind ?? 'models'
  const namespace = namespaceOf(ctx)
  const name = ctx.params.name ?? ''
  const repo = await repoOf(ctx.db, ctx.tenant, kind, namespace, name)
  if (repo === null) return repoNotFound()
  const key = repoKey(kind, namespace, name)
  const revision = ctx.params.rev ?? DEFAULT_REVISION
  const sha = await resolveRevision(ctx.db, ctx.tenant, key, revision)
  if (sha === null) return revisionNotFound(revision)
  const path = decodeURIComponent(ctx.params.path ?? '')
  const blob = await blobAt(ctx.db, ctx.tenant, key, sha, path)
  if (blob === null) return entryNotFound()
  const body = Buffer.from(blob.content)
  const etag = blob.lfsOid !== '' ? blob.lfsOid : blob.oid
  const headers: Record<string, string> = {
    ETag: `"${etag}"`,
    'X-Repo-Commit': sha,
    'Content-Type': 'application/octet-stream',
    // The real resolver states the content length even on a HEAD, which is how
    // a client sizes an LFS file without downloading it.
    'X-Linked-Size': String(body.length),
    'X-Linked-Etag': `"${etag}"`,
  }
  // The kit serves the window and owns the 206/416 wording; the vendor's own
  // headers above ride along on whichever status comes back, because a client
  // reads `X-Repo-Commit` off a partial response exactly as off a whole one.
  const windowed = rangeReply(ctx.headers, body)
  return { ...windowed, headers: { ...headers, ...windowed.headers } }
}

// ------------------------------------------------------------------ writes

async function preupload(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const found = await locate(ctx)
  if (isReply(found)) return found
  const body = obj(ctx.json())
  const files = Array.isArray(body.files) ? body.files : []
  return {
    status: 200,
    body: {
      files: files.map((raw) => {
        const file = obj(raw)
        const size = typeof file.size === 'number' ? file.size : 0
        return {
          path: str(file.path),
          // The threshold is the fake's, not the vendor's: what matters to a
          // client is that the answer is per file and that both modes appear,
          // so a 10 MiB line keeps the fixture small while still exercising
          // the lfs branch.
          uploadMode: size > 10 * 1024 * 1024 ? 'lfs' : 'regular',
          shouldIgnore: false,
        }
      }),
    },
  }
}

/**
 * The commit endpoint, which speaks newline-delimited JSON, not JSON.
 *
 * One `header` line then one line per operation, and the operations are
 * `file`, `deletedFile` and `deletedFolder`. A fake that accepted a JSON array
 * instead would pass a client that never learned the real shape.
 */
async function commit(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const found = await locate(ctx)
  if (isReply(found)) return found
  const { key } = found
  const revision = ctx.params.rev ?? DEFAULT_REVISION
  const lines = DEC.decode(ctx.body)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  let message = 'Update'
  let description = ''
  const changes: Change[] = []
  for (const line of lines) {
    let parsed: JsonValue
    try {
      parsed = JSON.parse(line) as JsonValue
    } catch {
      return hubError(400, 'BadRequest', 'Invalid ndjson line')
    }
    const row = obj(parsed)
    const value = obj(row.value)
    if (row.key === 'header') {
      message = str(value.summary, message)
      description = str(value.description, description)
      continue
    }
    if (row.key === 'file') {
      const encoding = str(value.encoding, 'utf-8')
      const content = str(value.content)
      changes.push({
        path: str(value.path),
        content:
          encoding === 'base64'
            ? new Uint8Array(Buffer.from(content, 'base64'))
            : new Uint8Array(Buffer.from(content, 'utf8')),
      })
      continue
    }
    if (row.key === 'deletedFile') {
      changes.push({ path: str(value.path), deleted: true })
      continue
    }
    if (row.key === 'deletedFolder') {
      changes.push({ path: str(value.path), deletedFolder: true })
      continue
    }
    return hubError(400, 'BadRequest', `Unknown commit operation: ${str(row.key)}`)
  }
  const sha = await commitChanges(
    ctx.db,
    ctx.tenant,
    key,
    revision,
    changes,
    message,
    description,
    ctx.clock.nowIso(),
    ctx.minter,
  )
  return {
    status: 200,
    body: {
      success: true,
      commitOid: sha,
      commitUrl: `${origin(ctx)}/${found.repo.namespace}/${found.repo.name}/commit/${sha}`,
    },
  }
}

async function createRepoRoute(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const body = obj(ctx.json())
  const name = str(body.name)
  const namespace = str(body.organization) || ctx.tenant
  const kind = `${str(body.type, 'model')}s`
  if (!KINDS.includes(kind)) return hubError(400, 'BadRequest', `Invalid repo type: ${kind}`)
  if (name === '') return hubError(400, 'BadRequest', 'name is required')
  const existing = await repoOf(ctx.db, ctx.tenant, kind, namespace, name)
  if (existing !== null) {
    // The Hub answers 409 for a repository that is already there, which is
    // what --exist-ok turns back into success. Answering 200 here instead
    // would make that flag untestable.
    //
    // The body still carries `url`, and that is not cosmetic: upstream's
    // create_repo swallows the 409 under exist_ok and then reads d["url"]
    // unconditionally (hf_api.py:3783), so a 409 body carrying only an error
    // raises KeyError inside the client. Probed with the real binary.
    const reply = hubError(409, 'RepoExists', 'You already created this model repo')
    return {
      ...reply,
      body: {
        error: 'You already created this model repo',
        url: repoUrl(origin(ctx), kind, namespace, name),
        name: `${namespace}/${name}`,
      },
    }
  }
  const sdk = str(body.sdk)
  if (kind === 'spaces' && sdk === '') {
    return hubError(400, 'BadRequest', 'Spaces require an sdk')
  }
  await createRepo(
    ctx.db,
    ctx.tenant,
    kind,
    namespace,
    name,
    {
      private: body.visibility === 'private',
      sdk: sdk === '' ? null : sdk,
      now: ctx.clock.nowIso(),
    },
    ctx.minter,
  )
  return {
    status: 200,
    body: {
      url: repoUrl(origin(ctx), kind, namespace, name),
      name: `${namespace}/${name}`,
    },
  }
}

async function deleteRepoRoute(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const body = obj(ctx.json())
  const name = str(body.name)
  const namespace = str(body.organization) || ctx.tenant
  const kind = `${str(body.type, 'model')}s`
  const repo = await repoOf(ctx.db, ctx.tenant, kind, namespace, name)
  if (repo === null) return repoNotFound()
  const key = repoKey(kind, namespace, name)
  await ctx.db.hfBlob.deleteMany({ where: { tenant: ctx.tenant, repo: key } })
  await ctx.db.hfRef.deleteMany({ where: { tenant: ctx.tenant, repo: key } })
  await ctx.db.hfCommit.deleteMany({ where: { tenant: ctx.tenant, repo: key } })
  await ctx.db.hfRepo.delete({
    where: { tenant_kind_namespace_name: { tenant: ctx.tenant, kind, namespace, name } },
  })
  return { status: 200, body: {} }
}

async function createTag(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const found = await locate(ctx)
  if (isReply(found)) return found
  const { key } = found
  const revision = ctx.params.rev ?? DEFAULT_REVISION
  const sha = await resolveRevision(ctx.db, ctx.tenant, key, revision)
  if (sha === null) return revisionNotFound(revision)
  const body = obj(ctx.json())
  const tag = str(body.tag)
  if (tag === '') return hubError(400, 'BadRequest', 'tag is required')
  const existing = await ctx.db.hfRef.findUnique({
    where: {
      tenant_repo_refType_name: { tenant: ctx.tenant, repo: key, refType: 'tag', name: tag },
    },
  })
  if (existing !== null) return hubError(409, 'TagExists', `Tag ${tag} already exists`)
  await ctx.db.hfRef.create({
    data: {
      tenant: ctx.tenant,
      repo: key,
      refType: 'tag',
      name: tag,
      sha,
      message: str(body.message),
    },
  })
  return { status: 200, body: {} }
}

async function deleteTag(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const found = await locate(ctx)
  if (isReply(found)) return found
  const tag = ctx.params.rev ?? ''
  const where = {
    tenant_repo_refType_name: {
      tenant: ctx.tenant,
      repo: found.key,
      refType: 'tag',
      name: tag,
    },
  }
  if ((await ctx.db.hfRef.findUnique({ where })) === null) return revisionNotFound(tag)
  await ctx.db.hfRef.delete({ where })
  return { status: 200, body: {} }
}

function whoami(ctx: Ctx<C>): Reply {
  if (!authed(ctx)) return unauthorized()
  return {
    status: 200,
    body: {
      type: 'user',
      name: ctx.tenant,
      fullname: ctx.tenant,
      email: `${ctx.tenant}@integ.invalid`,
      orgs: [{ name: 'integ-org', fullname: 'Integ Org' }],
      auth: { accessToken: { displayName: 'integ', role: 'write' } },
    },
  }
}

// A commit shas listing, which `git log`-shaped clients read.
async function commits(ctx: Ctx<C>): Promise<Reply> {
  const found = await locate(ctx)
  if (isReply(found)) return found
  const revision = ctx.params.rev ?? DEFAULT_REVISION
  if ((await resolveRevision(ctx.db, ctx.tenant, found.key, revision)) === null) {
    return revisionNotFound(revision)
  }
  const rows = await ctx.db.hfCommit.findMany({
    where: { tenant: ctx.tenant, repo: found.key },
    orderBy: { seq: 'desc' },
  })
  return {
    status: 200,
    body: rows.map((c) => ({
      id: c.sha,
      title: c.message,
      message: c.description,
      date: c.createdAt,
      authors: [{ user: ctx.tenant }],
    })),
  }
}

const KIND = ':kind'

// Every repository route exists twice, once for `ns/name` and once for the
// bare `name` the Hub resolves against the caller's own namespace. Emitting
// the pair from one call keeps them from drifting apart.
function repoRoute(
  method: string,
  suffix: string,
  handler: (ctx: Ctx<C>) => Promise<Reply> | Reply,
  opts: { write?: boolean } = {},
): KitRoute<C>[] {
  return [
    route(method, `/api/${KIND}/:ns/:name${suffix}`, handler, opts),
    route(method, `/api/${KIND}/:name${suffix}`, handler, opts),
  ]
}

function resolveRoutes(kind: string, prefix: string): KitRoute<C>[] {
  const bind = (ctx: Ctx<C>): Promise<Reply> => resolve({ ...ctx, params: { ...ctx.params, kind } })
  return [
    route('GET', `${prefix}/:ns/:name/resolve/:rev/*path`, bind),
    route('GET', `${prefix}/:name/resolve/:rev/*path`, bind),
  ]
}

export function hfHubRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/api/whoami-v2', whoami),
    // Two segments, where every repo route has three or more, so these cannot
    // collide with the `/api/:kind/:name` pair the comment below is about.
    ...KINDS.map((k) => route<C>('GET', `/api/${k}`, (ctx) => listRepos(k, ctx))),
    route('POST', '/api/repos/create', createRepoRoute, { write: true }),
    route('DELETE', '/api/repos/delete', deleteRepoRoute, { write: true }),
    // Every suffixed route comes FIRST, and the bare repoInfo pair last.
    // The router takes the first match, and `/api/:kind/:ns/:name` has the
    // same segment count as `/api/:kind/:name/refs`, so registering the
    // unsuffixed form earlier makes it swallow `/api/models/widget/refs` as
    // a repository literally named "refs". Probed: the real binary's
    // `repo tag list <bare-id>` answered "Model not found" because of it.
    ...repoRoute('GET', '/revision/:rev', repoInfo),
    ...repoRoute('GET', '/refs', refs),
    ...repoRoute('GET', '/commits/:rev', commits),
    ...repoRoute('GET', '/tree/:rev', tree),
    ...repoRoute('GET', '/tree/:rev/*path', tree),
    ...repoRoute('POST', '/preupload/:rev', preupload),
    ...repoRoute('POST', '/commit/:rev', commit, { write: true }),
    ...repoRoute('POST', '/tag/:rev', createTag, { write: true }),
    ...repoRoute('DELETE', '/tag/:rev', deleteTag, { write: true }),
    ...repoRoute('GET', '', repoInfo),
    // A model resolves at the origin root and the other two under their plural
    // segment, so the model form is separate rather than an optional segment:
    // `:kind` would otherwise swallow the namespace.
    ...resolveRoutes('datasets', '/datasets'),
    ...resolveRoutes('spaces', '/spaces'),
    ...resolveRoutes('models', ''),
  ]
}
