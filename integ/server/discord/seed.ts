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

import type { Prisma } from '../../generated/discord/index.js'
import type { PrismaClient } from '../../generated/discord/index.js'
import { idWhere, tenantWhere } from '../kit/typescript/tenant.ts'
import type { TenantKind } from '../kit/typescript/types.ts'
import type { JsonValue } from '../kit/typescript/types.ts'
import { BASE_TOKEN, isObject } from './wire.ts'

type Row = { [key: string]: JsonValue }

function asRow(v: JsonValue | undefined): Row {
  return v !== undefined && isObject(v) ? v : {}
}

function asText(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asBigInt(text: string): bigint {
  return /^[+-]?\d+$/.test(text.trim()) ? BigInt(text.trim()) : 0n
}

// The one lookup the python fake did by scanning: a message's author id is
// resolved against every member seeded SO FAR, in guild order then member
// order, and falls back to a synthetic user when nothing matches. The pk order
// is insertion order, so findFirst reproduces the scan exactly, including the
// case where a later guild's member cannot answer an earlier guild's message.
async function userFor(
  db: PrismaClient,
  tenant: string,
  kind: TenantKind,
  userId: string,
): Promise<JsonValue> {
  const hit = await db.discordMember.findFirst({
    where: { ...tenantWhere<Prisma.DiscordMemberWhereInput>(tenant, kind), userId },
    orderBy: { pk: 'asc' },
  })
  if (hit === null) return { id: userId, username: 'unknown', bot: false }
  const payload = JSON.parse(hit.payloadJson) as JsonValue
  const user = asRow(asRow(payload).user)
  return user
}

const UTF8 = new TextEncoder()

interface Wired {
  wire: JsonValue[]
  blobs: { id: string; body: Uint8Array<ArrayBuffer> }[]
}

// Attachments end up in two disjoint containers. The wire list rides on the
// message and keeps the {base} placeholder unresolved, because the origin is
// only known per request; the bytes go to the blob store the CDN route reads.
// A tombstoned attachment appears only in the wire list, with no url and no
// size, so a client cannot list it as a downloadable file.
function wireAttachments(raws: JsonValue): Wired {
  const out: Wired = { wire: [], blobs: [] }
  if (!Array.isArray(raws)) return out
  for (const item of raws) {
    const att = asRow(item)
    const id = asText(att.id)
    const filename = asText(att.filename)
    if (att.tombstoned === true) {
      out.wire.push({ id, filename })
      continue
    }
    const body = new Uint8Array(UTF8.encode(asText(att.body)))
    out.blobs.push({ id, body })
    out.wire.push({
      id,
      filename,
      size: body.length,
      url: `${BASE_TOKEN}/attachments/${id}/${filename}`,
      proxy_url: `${BASE_TOKEN}/attachments/${id}/${filename}`,
      content_type: asText(att.content_type, 'application/octet-stream'),
    })
  }
  return out
}

function bump(counts: Record<string, number>, model: string): void {
  counts[model] = (counts[model] ?? 0) + 1
}

function resort(counts: Record<string, number>): void {
  const sorted = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))
  for (const key of Object.keys(counts)) delete counts[key]
  for (const [key, value] of sorted) counts[key] = value
}

async function seedMembers(
  db: PrismaClient,
  tenant: string,
  guildId: string,
  raw: string | null,
  counts: Record<string, number>,
): Promise<void> {
  const parsed = raw === null ? [] : (JSON.parse(raw) as JsonValue)
  const rows = Array.isArray(parsed) ? parsed : []
  let seq = 0
  for (const item of rows) {
    const member = asRow(item)
    const user = asRow(member.user)
    const userId = asText(user.id)
    await db.discordMember.create({
      data: {
        tenant,
        guildId,
        seq,
        userId,
        userIdNum: asBigInt(userId),
        username: asText(user.username),
        nick: typeof member.nick === 'string' ? member.nick : null,
        payloadJson: JSON.stringify(member),
      },
    })
    bump(counts, 'DiscordMember')
    seq += 1
  }
}

async function seedChannelMessages(
  db: PrismaClient,
  tenant: string,
  kind: TenantKind,
  guildId: string,
  channelId: string,
  raws: JsonValue,
  counts: Record<string, number>,
): Promise<string | null> {
  const list = Array.isArray(raws) ? raws.map(asRow) : []
  // Stored in snowflake order, which is what the positional window and the
  // channel's last_message_id both read.
  list.sort((a, b) => {
    const x = asBigInt(asText(a.id))
    const y = asBigInt(asText(b.id))
    return x < y ? -1 : x > y ? 1 : 0
  })
  let seq = 0
  let last: string | null = null
  for (const raw of list) {
    const id = asText(raw.id)
    const author = await userFor(db, tenant, kind, asText(raw.author))
    const att = wireAttachments(raw.attachments ?? [])
    for (const blob of att.blobs) {
      await db.discordBlob.upsert({
        where: idWhere<Prisma.DiscordBlobWhereUniqueInput>(tenant, blob.id, kind),
        update: { body: blob.body },
        create: { tenant, id: blob.id, seq, body: blob.body },
      })
      bump(counts, 'DiscordBlob')
    }
    await db.discordMessage.create({
      data: {
        tenant,
        id,
        seq,
        idNum: asBigInt(id),
        channelId,
        guildId,
        content: asText(raw.content),
        timestamp: asText(raw.timestamp),
        editedTimestamp: null,
        authorJson: JSON.stringify(author),
        attachmentsJson: JSON.stringify(att.wire),
        pollJson: null,
      },
    })
    bump(counts, 'DiscordMessage')
    last = id
    seq += 1
  }
  return last
}

// The generic seeder writes the guild and its channels; everything below is
// what the fixture nests in a shape no relation can express. `members` is a
// list whose rows are handed back verbatim, and `messages` is a MAP keyed by
// channel id hanging off the guild rather than off the channel it belongs to.
// Both arrive as staging JSON on the guild row and are cleared once expanded.
export async function materialize(
  db: PrismaClient,
  tenant: string,
  kind: TenantKind,
  counts: Record<string, number>,
): Promise<void> {
  const guilds = await db.discordGuild.findMany({
    where: tenantWhere<Prisma.DiscordGuildWhereInput>(tenant, kind),
    orderBy: { seq: 'asc' },
  })
  for (const guild of guilds) {
    const where = idWhere<Prisma.DiscordGuildWhereUniqueInput>(tenant, guild.id, kind)
    await db.discordGuild.update({ where, data: { idNum: asBigInt(guild.id) } })
    await seedMembers(db, tenant, guild.id, guild.members, counts)
    const parsed = guild.messages === null ? {} : (JSON.parse(guild.messages) as JsonValue)
    const byChannel = asRow(parsed)
    const channels = await db.discordChannel.findMany({
      where: { ...tenantWhere<Prisma.DiscordChannelWhereInput>(tenant, kind), guildId: guild.id },
      orderBy: { seq: 'asc' },
    })
    for (const channel of channels) {
      const last = await seedChannelMessages(
        db,
        tenant,
        kind,
        guild.id,
        channel.id,
        byChannel[channel.id] ?? [],
        counts,
      )
      await db.discordChannel.update({
        where: idWhere<Prisma.DiscordChannelWhereUniqueInput>(tenant, channel.id, kind),
        data: { lastMessageId: last },
      })
    }
    await db.discordGuild.update({ where, data: { members: null, messages: null } })
  }
  resort(counts)
}
