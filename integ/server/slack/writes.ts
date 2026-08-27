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

import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import { BOT_USER_ID, POST_TS_BASE, type C } from './config.ts'
import { channelById, messageAt, messageKey, pinKey } from './store.ts'
import { fail, reactionsOf } from './wire.ts'

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function str(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

// Every write refuses an anonymous caller, which is what the vendor does and
// what makes the mount's token configuration load-bearing.
function authed(ctx: Ctx<C>): boolean {
  const raw = ctx.headers.authorization
  const one = Array.isArray(raw) ? raw[0] : raw
  return one !== undefined && one.startsWith('Bearer ') && one.slice(7) !== ''
}

export async function postMessage(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return fail('not_authed')
  const payload = obj(ctx.json())
  const channel = str(payload.channel)
  const text = str(payload.text)
  if (channel === '') return fail('channel_not_found')
  // The row has to land somewhere real, so an unknown channel is rejected
  // rather than left as an orphan message no listing can reach.
  if ((await channelById(ctx.db, ctx.tenant, channel)) === null) return fail('channel_not_found')
  const n = ctx.minter.next('post')
  const ts = `${String(POST_TS_BASE)}.${String(n).padStart(6, '0')}`
  const threadTs = str(payload.thread_ts) === '' ? null : str(payload.thread_ts)
  await ctx.db.message.create({
    data: {
      tenant: ctx.tenant,
      channelId: channel,
      ts,
      userId: BOT_USER_ID,
      text,
      threadTs,
      reactionsJson: null,
      seq: n,
    },
  })
  const message: Record<string, JsonValue> = { type: 'message', user: BOT_USER_ID, text, ts }
  if (threadTs !== null) message.thread_ts = threadTs
  return { status: 200, body: { ok: true, channel, ts, message } }
}

export async function reactionsAdd(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return fail('not_authed')
  const payload = obj(ctx.json())
  const channel = str(payload.channel)
  const timestamp = str(payload.timestamp)
  const name = str(payload.name)
  const msg = await messageAt(ctx.db, ctx.tenant, channel, timestamp)
  if (msg === null) return fail('message_not_found')
  const reactions = reactionsOf(msg.reactionsJson)
  const existing = reactions.find((r) => r.name === name)
  if (existing !== undefined && existing.users.includes(BOT_USER_ID)) return fail('already_reacted')
  if (existing === undefined) reactions.push({ name, users: [BOT_USER_ID], count: 1 })
  else {
    existing.users.push(BOT_USER_ID)
    existing.count = existing.users.length
  }
  await ctx.db.message.update({
    where: messageKey(ctx.tenant, channel, timestamp),
    data: { reactionsJson: JSON.stringify(reactions) },
  })
  return { status: 200, body: { ok: true } }
}

export function pins(add: boolean) {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    if (!authed(ctx)) return fail('not_authed')
    const payload = obj(ctx.json())
    const channel = str(payload.channel)
    const timestamp = str(payload.timestamp)
    if ((await messageAt(ctx.db, ctx.tenant, channel, timestamp)) === null) {
      return fail('message_not_found')
    }
    const key = pinKey(ctx.tenant, channel, timestamp)
    const pinned = await ctx.db.pin.findUnique({ where: key })
    if (add) {
      if (pinned !== null) return fail('already_pinned')
      await ctx.db.pin.create({
        data: {
          tenant: ctx.tenant,
          channelId: channel,
          ts: timestamp,
          createdBy: BOT_USER_ID,
          created: Math.floor(Number(timestamp)),
          seq: ctx.minter.next('pin'),
        },
      })
      return { status: 200, body: { ok: true } }
    }
    if (pinned === null) return fail('no_pin')
    await ctx.db.pin.delete({ where: key })
    return { status: 200, body: { ok: true } }
  }
}
