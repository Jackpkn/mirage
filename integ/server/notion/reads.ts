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

import type { Ctx, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { DEFAULT_API_VERSION, MAX_PAGE_SIZE } from './config.ts'
import { searchResults, databaseRows } from './search.ts'
import { childrenOf, markdownOf, metaOf } from './store.ts'
import type { BlockRow, DatabaseRow, PageRow } from './types.ts'
import {
  apiError,
  asObject,
  blockJson,
  cursorOf,
  dataSourceJson,
  databaseIdOf,
  databaseJson,
  intOr,
  notFound,
  pageJson,
  pageOf,
} from './wire.ts'

// The kit resolves a tenant from the bearer with a FALLBACK to the default
// one, because an unreadable vendor token has asked for nothing. Notion asks
// for something: a call with no token at all is a 401 in its own words, and
// the fake this replaces answered that. So presence is checked here rather
// than in the kit, where a fallback is the right answer for every other fake.
export function unauthorized(ctx: Ctx<C>): Reply | null {
  const raw = ctx.headers.authorization
  const auth = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  if (auth.startsWith('Bearer ') && auth.slice(7) !== '') return null
  return apiError(401, 'unauthorized', 'API token is invalid.')
}

// Notion answers each request in the shape of the version it carries, and the
// two generations disagree about where a database's column schema lives, so
// the header has to reach the renderer rather than being read once at startup.
function apiVersion(ctx: Ctx<C>): string {
  const raw = ctx.headers['notion-version']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === '' ? DEFAULT_API_VERSION : value
}

function markdownReply(id: string, lines: string[]): Reply {
  return {
    status: 200,
    body: {
      object: 'page_markdown',
      id,
      markdown: lines.length === 0 ? '' : `${lines.join('\n\n')}\n`,
      truncated: false,
      unknown_block_ids: [],
    },
  }
}

export { markdownReply }

export async function retrievePage(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const row = (await ctx.db.notionPage.findFirst({
    where: { tenant: ctx.tenant, id },
  })) as PageRow | null
  if (row === null) return notFound('page', id)
  return { status: 200, body: pageJson(row) }
}

export async function whoami(ctx: Ctx<C>): Promise<Reply> {
  const meta = await metaOf(ctx.db, ctx.tenant)
  return {
    status: 200,
    body: {
      object: 'user',
      id: meta.botId,
      name: meta.botName,
      avatar_url: null,
      type: 'bot',
      bot: {
        owner: { type: 'workspace', workspace: true },
        workspace_name: meta.workspaceName,
        workspace_id: meta.workspaceId,
        workspace_limits: { max_file_upload_size_in_bytes: meta.maxUploadSize },
      },
    },
  }
}

export async function pageMarkdown(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const row = await ctx.db.notionPage.findFirst({ where: { tenant: ctx.tenant, id } })
  if (row === null) return notFound('page', id)
  const lines: string[] = []
  await markdownOf(ctx.db, ctx.tenant, id, 0, lines)
  return markdownReply(id, lines)
}

export async function retrieveDataSource(ctx: Ctx<C>): Promise<Reply> {
  const wanted = ctx.params.id ?? ''
  const all = (await ctx.db.notionDatabase.findMany({
    where: { tenant: ctx.tenant },
  })) as DatabaseRow[]
  const owner = databaseIdOf(wanted, all)
  const row = all.find((d) => d.id === owner)
  if (row === undefined) return notFound('data source', wanted)
  return { status: 200, body: dataSourceJson(row) }
}

export async function queryDataSource(ctx: Ctx<C>): Promise<Reply> {
  const wanted = ctx.params.id ?? ''
  const body = asObject(ctx.json())
  const all = (await ctx.db.notionDatabase.findMany({
    where: { tenant: ctx.tenant },
  })) as DatabaseRow[]
  const owner = databaseIdOf(wanted, all)
  if (owner === null) return notFound('data source', wanted)
  const rows = await databaseRows(ctx.db, ctx.tenant, owner, body)
  const size = intOr(body.page_size, MAX_PAGE_SIZE)
  return { status: 200, body: pageOf(rows, cursorOf(body.start_cursor), size) }
}

export async function retrieveDatabase(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const row = (await ctx.db.notionDatabase.findFirst({
    where: { tenant: ctx.tenant, id },
  })) as DatabaseRow | null
  if (row === null) return notFound('database', id)
  return { status: 200, body: databaseJson(row, apiVersion(ctx)) }
}

export async function queryDatabase(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const body = asObject(ctx.json())
  const owner = await ctx.db.notionDatabase.findFirst({ where: { tenant: ctx.tenant, id } })
  if (owner === null) return notFound('database', id)
  const rows = await databaseRows(ctx.db, ctx.tenant, id, body)
  const size = intOr(body.page_size, MAX_PAGE_SIZE)
  return { status: 200, body: pageOf(rows, cursorOf(body.start_cursor), size) }
}

export async function blockChildren(ctx: Ctx<C>): Promise<Reply> {
  const rows = await childrenOf(ctx.db, ctx.tenant, ctx.params.id ?? '')
  const size = intOr(ctx.query.get('page_size'), MAX_PAGE_SIZE)
  return {
    status: 200,
    body: pageOf(rows.map(blockJson), ctx.query.get('start_cursor'), size),
  }
}

// Retrieve one block. The children route existed and this one did not, which
// is a gap only a client that walks *to* a block notices:
// @notionhq/notion-mcp-server reads an inline database by asking for the block
// whose id it is, and got a 404 saying the object did not exist. A database and
// a page both answer, because in Notion the child_database / child_page block
// and the thing it points at share an id; a trashed row still answers with the
// flag set, the way retrieve serves a trashed page and DELETE reports the block
// it just trashed.
export async function retrieveBlock(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const scope = { tenant: ctx.tenant, id }
  const block = (await ctx.db.notionBlock.findFirst({ where: scope })) as BlockRow | null
  if (block !== null) {
    return {
      status: 200,
      body: { ...blockJson(block), archived: block.inTrash, in_trash: block.inTrash },
    }
  }
  const database = (await ctx.db.notionDatabase.findFirst({ where: scope })) as DatabaseRow | null
  if (database !== null) {
    return {
      status: 200,
      body: {
        object: 'block',
        id: database.id,
        type: 'child_database',
        has_children: false,
        child_database: { title: database.titleText },
        archived: database.inTrash,
        in_trash: database.inTrash,
      },
    }
  }
  const page = (await ctx.db.notionPage.findFirst({ where: scope })) as PageRow | null
  if (page !== null) {
    const kids = await childrenOf(ctx.db, ctx.tenant, id)
    return {
      status: 200,
      body: {
        object: 'block',
        id: page.id,
        type: 'child_page',
        has_children: kids.length > 0,
        child_page: { title: page.titleText },
        archived: page.inTrash,
        in_trash: page.inTrash,
      },
    }
  }
  return notFound('block', id)
}

export async function search(ctx: Ctx<C>): Promise<Reply> {
  const body = asObject(ctx.json())
  const results = await searchResults(ctx.db, ctx.tenant, body, apiVersion(ctx))
  const size = intOr(body.page_size, MAX_PAGE_SIZE)
  return { status: 200, body: pageOf(results, cursorOf(body.start_cursor), size) }
}
