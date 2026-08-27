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
import { LIST_LIMIT, SEARCH_LIMIT, type C } from './config.ts'
import {
  addFolder,
  copyTree,
  fileAt,
  itemAt,
  listChildren,
  putFile,
  remove,
  saveCursor,
  scopedItems,
  takeCursor,
} from './store.ts'
import {
  apiError,
  basename,
  entryFor,
  malformed,
  matchTag,
  searchMatch,
  wholeWordHit,
} from './wire.ts'

const DEC = new TextDecoder()

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function str(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: JsonValue | undefined, fallback: number): number {
  return typeof v === 'number' ? v : fallback
}

// The vendor takes the path in a header on its content endpoints, not in the
// body, because the body IS the file.
function argPath(ctx: Ctx<C>): string {
  const raw = ctx.headers['dropbox-api-arg']
  const one = Array.isArray(raw) ? raw[0] : raw
  if (one === undefined) return ''
  return str(obj(JSON.parse(one) as JsonValue).path)
}

function formField(body: Buffer, name: string): string {
  return new URLSearchParams(body.toString('utf8')).get(name) ?? ''
}

// The access token IS the account. Echoing the caller's refresh token back is
// what lets tenantFromBearer read the account off the Authorization header the
// RPC layer already sends, so one process serves the several isolated accounts
// a target mounts. A caller that sent no refresh token gets the shared default,
// which is the single-account case every existing corpus line expects.
function token(ctx: Ctx<C>): Reply {
  const refresh = formField(ctx.body, 'refresh_token')
  return {
    status: 200,
    body: { access_token: refresh === '' ? 'integ-token' : refresh, expires_in: 14400 },
  }
}

function page(entries: JsonValue[], cursor: string | null, hasMore: boolean): JsonValue {
  const out: Record<string, JsonValue> = { entries, has_more: hasMore }
  if (cursor !== null) out.cursor = cursor
  return out
}

// Takes RENDERED entries, not rows, because the tail is parked in a cursor as
// JSON: an Item carries `content` as a Uint8Array, which JSON.stringify writes
// out as a numeric-keyed object and JSON.parse hands back as one, so the
// continuation then fed a plain object to createHash and answered 500. Search
// already paginates over rendered matches; list is the one that did not.
async function listPage(ctx: Ctx<C>, entries: JsonValue[], limit: number): Promise<Reply> {
  const head = entries.slice(0, limit)
  const tail = entries.slice(limit)
  // A cursor is always handed out, even for a complete listing, because the
  // vendor always does: a client that only continues when has_more is set is
  // the one being tested, and a fake that omitted the field would let a client
  // that reads cursor unconditionally pass by accident.
  const cursor = await saveCursor(ctx.db, ctx.tenant, 'list', JSON.stringify(tail), ctx.minter)
  return {
    status: 200,
    body: page(head, cursor, tail.length > 0),
  }
}

async function listFolder(ctx: Ctx<C>): Promise<Reply> {
  const body = obj(ctx.json())
  const items = await listChildren(ctx.db, ctx.tenant, str(body.path), body.recursive === true)
  if (items === null) return apiError('path/not_found/...')
  return listPage(ctx, items.map(entryFor), num(body.limit, LIST_LIMIT))
}

async function listContinue(ctx: Ctx<C>): Promise<Reply> {
  const payload = await takeCursor(ctx.db, ctx.tenant, str(obj(ctx.json()).cursor), 'list')
  if (payload === null) return apiError('reset/...')
  return listPage(ctx, JSON.parse(payload) as JsonValue[], LIST_LIMIT)
}

async function getMetadata(ctx: Ctx<C>): Promise<Reply> {
  const item = await itemAt(ctx.db, ctx.tenant, str(obj(ctx.json()).path))
  if (item === null) return apiError('path/not_found/...')
  return { status: 200, body: entryFor(item) }
}

// The Range arm is the reason this fake had to stop existing twice: its python
// twin served 206/416 here and this one served 200 with the whole file, so a
// windowed read was a full transfer on the TypeScript host and the push-down
// was never exercised. rangeReply is the kit's, so neither can drift again.
async function download(ctx: Ctx<C>): Promise<Reply> {
  const item = await fileAt(ctx.db, ctx.tenant, argPath(ctx))
  if (item === null) return apiError('path/not_found/...')
  return rangeReply(ctx.headers, item.content ?? new Uint8Array(0))
}

async function upload(ctx: Ctx<C>): Promise<Reply> {
  const path = argPath(ctx)
  if (path === '') return malformed()
  const at = await itemAt(ctx.db, ctx.tenant, path)
  if (at !== null && at.isFolder) return apiError('path/conflict/folder/...')
  // Uploads stamp the run clock, which is anchored at /reset rather than
  // pinned in the past, so `find -mtime -1` sees a just-written file as fresh
  // exactly as it does against MinIO in the s3 targets.
  const item = await putFile(
    ctx.db,
    ctx.tenant,
    path,
    new Uint8Array(ctx.body),
    ctx.clock.nowIso(false),
    ctx.minter,
  )
  return { status: 200, body: entryFor(item) }
}

async function createFolder(ctx: Ctx<C>): Promise<Reply> {
  const path = str(obj(ctx.json()).path)
  if (path === '') return malformed()
  if ((await itemAt(ctx.db, ctx.tenant, path)) !== null) {
    return apiError('path/conflict/folder/...')
  }
  const item = await addFolder(ctx.db, ctx.tenant, path, ctx.minter)
  return { status: 200, body: { metadata: entryFor(item) } }
}

async function deleteItem(ctx: Ctx<C>): Promise<Reply> {
  const path = str(obj(ctx.json()).path)
  if (path === '') return malformed()
  const item = await itemAt(ctx.db, ctx.tenant, path)
  if (item === null) return apiError('path_lookup/not_found/...')
  await remove(ctx.db, ctx.tenant, path)
  return { status: 200, body: { metadata: entryFor(item) } }
}

// move_v2 and copy_v2 differ by one line, which is the vendor's own framing:
// the argument shape, the conflict rules and the response are identical.
function relocate(isMove: boolean) {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    const body = obj(ctx.json())
    const from = str(body.from_path)
    const to = str(body.to_path)
    if (from === '' || to === '') return malformed()
    const src = await itemAt(ctx.db, ctx.tenant, from)
    if (src === null) return apiError('from_lookup/not_found/...')
    const dst = await itemAt(ctx.db, ctx.tenant, to)
    if (dst !== null) {
      return apiError(dst.isFolder ? 'to/conflict/folder/...' : 'to/conflict/file/...')
    }
    await copyTree(ctx.db, ctx.tenant, from, to, ctx.minter)
    if (isMove) await remove(ctx.db, ctx.tenant, from)
    const moved = await itemAt(ctx.db, ctx.tenant, to)
    return { status: 200, body: { metadata: moved === null ? null : entryFor(moved) } }
  }
}

interface SearchState {
  matches: JsonValue[]
  start: number
  limit: number
}

async function searchPage(ctx: Ctx<C>, state: SearchState): Promise<Reply> {
  const { matches, start, limit } = state
  const slice = matches.slice(start, start + limit)
  const hasMore = start + limit < matches.length
  const out: Record<string, JsonValue> = { matches: slice, has_more: hasMore }
  if (hasMore) {
    out.cursor = await saveCursor(
      ctx.db,
      ctx.tenant,
      'search',
      JSON.stringify({ matches, start: start + limit, limit }),
      ctx.minter,
    )
  }
  return { status: 200, body: out }
}

async function search(ctx: Ctx<C>): Promise<Reply> {
  const body = obj(ctx.json())
  const query = str(body.query)
  if (query === '') return { status: 400, body: { error_summary: 'invalid_argument' } }
  const options = obj(body.options)
  const items = await scopedItems(ctx.db, ctx.tenant, str(options.path))
  if (items === null) return apiError('path/not_found/...')
  const q = query.toLowerCase()
  const filenameOnly = options.filename_only === true
  const matches: JsonValue[] = []
  for (const item of items) {
    const nameHit = basename(item.path).toLowerCase().includes(q)
    const contentHit =
      !filenameOnly &&
      !item.isFolder &&
      item.content !== null &&
      wholeWordHit(q, DEC.decode(item.content).toLowerCase())
    if (!nameHit && !contentHit) continue
    matches.push(searchMatch(item, matchTag(nameHit, contentHit)))
  }
  return searchPage(ctx, { matches, start: 0, limit: num(options.max_results, SEARCH_LIMIT) })
}

async function searchContinue(ctx: Ctx<C>): Promise<Reply> {
  const payload = await takeCursor(ctx.db, ctx.tenant, str(obj(ctx.json()).cursor), 'search')
  if (payload === null) return apiError('reset/...')
  return searchPage(ctx, JSON.parse(payload) as SearchState)
}

export function dropboxRoutes(): KitRoute<C>[] {
  return [
    route('POST', '/oauth2/token', token),
    route('POST', '/2/files/list_folder', listFolder),
    route('POST', '/2/files/list_folder/continue', listContinue, { write: true }),
    route('POST', '/2/files/get_metadata', getMetadata),
    route('POST', '/2/files/download', download),
    route('POST', '/2/files/upload', upload, { write: true }),
    route('POST', '/2/files/create_folder_v2', createFolder, { write: true }),
    route('POST', '/2/files/delete_v2', deleteItem, { write: true }),
    route('POST', '/2/files/move_v2', relocate(true), { write: true }),
    route('POST', '/2/files/copy_v2', relocate(false), { write: true }),
    route('POST', '/2/files/search_v2', search, { write: true }),
    route('POST', '/2/files/search/continue_v2', searchContinue, { write: true }),
  ]
}
