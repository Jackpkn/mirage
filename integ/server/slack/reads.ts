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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rangeReply } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { channelById, channels, fileById, filesIn, users } from './store.ts'
import type { MessageRow } from './store.ts'
import { CUSTOM_EMOJI, channelJson, fail, messageJson, reactionsOf, userJson } from './wire.ts'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'slack')

export function fileBytes(f: { content: string; contentPath: string | null }): Buffer {
  return f.contentPath !== null && f.contentPath !== ''
    ? readFileSync(join(FIXTURE_DIR, f.contentPath))
    : Buffer.from(f.content, 'utf8')
}

function intQuery(ctx: Ctx<C>, name: string, fallback: number): number {
  const raw = ctx.query.get(name)
  return raw === null ? fallback : Number.parseInt(raw, 10)
}

export async function conversationsList(ctx: Ctx<C>): Promise<Reply> {
  const types = (ctx.query.get('types') ?? '').split(',').filter((t) => t !== '')
  const kinds = types.map((t) =>
    t === 'public_channel' || t === 'private_channel' ? 'channel' : t,
  )
  const where: Record<string, JsonValue> = {
    tenant: ctx.tenant,
    kind: { in: kinds.length > 0 ? kinds : ['channel'] },
  }
  if (ctx.query.get('exclude_archived') === 'true') where.isArchived = false
  const rows = await ctx.db.channel.findMany({ where, orderBy: { id: 'asc' } })
  return {
    status: 200,
    body: { ok: true, channels: rows.map(channelJson), response_metadata: { next_cursor: '' } },
  }
}

export async function conversationsHistory(ctx: Ctx<C>): Promise<Reply> {
  const channel = ctx.query.get('channel') ?? ''
  const oldest = ctx.query.get('oldest')
  const latest = ctx.query.get('latest')
  const where: Record<string, JsonValue> = { tenant: ctx.tenant, channelId: channel }
  const ts: Record<string, string> = {}
  if (oldest !== null) ts.gte = oldest
  if (latest !== null) ts.lte = latest
  if (Object.keys(ts).length > 0) where.ts = ts
  // Slack returns most-recent-first; the backend re-sorts the day window.
  const rows: MessageRow[] = await ctx.db.message.findMany({
    where,
    orderBy: { ts: 'desc' },
    take: intQuery(ctx, 'limit', 100),
  })
  const files = await filesIn(ctx.db, ctx.tenant, channel)
  const messages = rows.map((m) =>
    messageJson(
      m,
      files.filter((f) => f.messageTs === m.ts),
      ctx.url.origin,
    ),
  )
  return { status: 200, body: { ok: true, messages, response_metadata: { next_cursor: '' } } }
}

export async function usersList(ctx: Ctx<C>): Promise<Reply> {
  const rows = await users(ctx.db, ctx.tenant)
  return {
    status: 200,
    body: { ok: true, members: rows.map(userJson), response_metadata: { next_cursor: '' } },
  }
}

export async function usersInfo(ctx: Ctx<C>): Promise<Reply> {
  const row = await ctx.db.user.findUnique({
    where: { tenant_id: { tenant: ctx.tenant, id: ctx.query.get('user') ?? '' } },
  })
  if (row === null) return fail('user_not_found')
  return { status: 200, body: { ok: true, user: userJson(row) } }
}

export async function pinsList(ctx: Ctx<C>): Promise<Reply> {
  const channel = ctx.query.get('channel') ?? ''
  const pinned = await ctx.db.pin.findMany({
    where: { tenant: ctx.tenant, channelId: channel },
    orderBy: { ts: 'asc' },
  })
  const items: JsonValue[] = []
  for (const pin of pinned) {
    const m = await ctx.db.message.findUnique({
      where: { tenant_channelId_ts: { tenant: ctx.tenant, channelId: channel, ts: pin.ts } },
    })
    if (m === null) continue
    items.push({
      type: 'message',
      channel,
      message: { type: m.type, user: m.userId, text: m.text, ts: m.ts },
    })
  }
  return { status: 200, body: { ok: true, items } }
}

export async function reactionsGet(ctx: Ctx<C>): Promise<Reply> {
  const channel = ctx.query.get('channel') ?? ''
  const timestamp = ctx.query.get('timestamp') ?? ''
  const m = await ctx.db.message.findUnique({
    where: { tenant_channelId_ts: { tenant: ctx.tenant, channelId: channel, ts: timestamp } },
  })
  if (m === null) return fail('message_not_found')
  const message: Record<string, JsonValue> = {
    type: m.type,
    user: m.userId,
    text: m.text,
    ts: m.ts,
  }
  const rs = reactionsOf(m.reactionsJson)
  if (rs.length > 0) {
    message.reactions = rs.map((r) => ({ name: r.name, users: r.users, count: r.count }))
  }
  return { status: 200, body: { ok: true, message, type: 'message', channel } }
}

export function emojiList(): Reply {
  return { status: 200, body: { ok: true, emoji: CUSTOM_EMOJI } }
}

// Slack serves files from a CDN that honours Range. The fake this replaces
// hand-rolled the parse and read `bytes=-5` as the FIRST six bytes rather than
// the last five, which is the same defect the dropbox and box fakes each had
// independently; rangeReply is the kit's, so there is one implementation now.
export async function download(ctx: Ctx<C>): Promise<Reply> {
  const file = await fileById(ctx.db, ctx.tenant, ctx.params.id ?? '')
  if (file === null) return { status: 404, body: { error: 'not_found' } }
  return rangeReply(ctx.headers, fileBytes(file), file.mimetype)
}

export { channelById, channels }
