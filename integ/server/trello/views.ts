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

import type { Prisma } from '../../generated/trello/index.js'
import { idWhere, tenantWhere } from '../kit/typescript/index.ts'
import type { JsonValue, Reply } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'

const KIND = config.tenantKind

export interface BoardRow {
  id: string
  workspaceId: string
  name: string
  closed: boolean
  url: string | null
  dateLastActivity: string | null
}

export function notFound(what: string): Reply {
  return { status: 404, body: { message: `${what} not found` } }
}

export function boardJson(b: BoardRow): JsonValue {
  return {
    id: b.id,
    name: b.name,
    idOrganization: b.workspaceId,
    closed: b.closed,
    url: b.url,
    dateLastActivity: b.dateLastActivity,
  }
}

// A card's members and labels are one ordered id list per card, stored as
// JSON. The vendor's add endpoints answer with exactly that list, so it is
// what both the write and the render read.
export function parseIds(raw: string): string[] {
  const parsed = JSON.parse(raw) as JsonValue
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
}

export function memberWhere(tenant: string, id: string): Prisma.TrelloMemberWhereUniqueInput {
  return idWhere<Prisma.TrelloMemberWhereUniqueInput>(tenant, id, KIND)
}

export function cardWhere(tenant: string, id: string): Prisma.TrelloCardWhereUniqueInput {
  return idWhere<Prisma.TrelloCardWhereUniqueInput>(tenant, id, KIND)
}

export function listWhere(tenant: string, id: string): Prisma.TrelloListWhereUniqueInput {
  return idWhere<Prisma.TrelloListWhereUniqueInput>(tenant, id, KIND)
}

export function boardWhere(tenant: string, id: string): Prisma.TrelloBoardWhereUniqueInput {
  return idWhere<Prisma.TrelloBoardWhereUniqueInput>(tenant, id, KIND)
}

export function workspaceWhere(tenant: string, id: string): Prisma.TrelloWorkspaceWhereUniqueInput {
  return idWhere<Prisma.TrelloWorkspaceWhereUniqueInput>(tenant, id, KIND)
}

export function commentWhere(tenant: string, id: string): Prisma.TrelloCommentWhereUniqueInput {
  return idWhere<Prisma.TrelloCommentWhereUniqueInput>(tenant, id, KIND)
}

export async function cardMemberIds(db: C, tenant: string, cardId: string): Promise<string[]> {
  const card = await db.trelloCard.findUnique({ where: cardWhere(tenant, cardId) })
  return card === null ? [] : parseIds(card.idMembers)
}

export async function cardLabelIds(db: C, tenant: string, cardId: string): Promise<string[]> {
  const card = await db.trelloCard.findUnique({ where: cardWhere(tenant, cardId) })
  return card === null ? [] : parseIds(card.labelIds)
}

// idBoard is read through the card's list rather than stored a second time on
// the card: a move rewrites idList, and a board that disagreed with the list
// the card is in is a state the vendor cannot be in. The list is a separate
// point lookup rather than an `include`, because relationMode="prisma" has no
// foreign key to enforce the relation: a dangling listId types as a non-null
// row and dereferences as undefined, which is a TypeError inside the render
// rather than a rendered idBoard.
export async function cardView(db: C, tenant: string, cardId: string): Promise<JsonValue | null> {
  const card = await db.trelloCard.findUnique({ where: cardWhere(tenant, cardId) })
  if (card === null) return null
  const list = await db.trelloList.findUnique({ where: listWhere(tenant, card.listId) })
  const memberIds = parseIds(card.idMembers)
  const labelIds = parseIds(card.labelIds)
  const labels: JsonValue[] = []
  for (const labelId of labelIds) {
    const label = await db.trelloLabel.findUnique({
      where: idWhere<Prisma.TrelloLabelWhereUniqueInput>(tenant, labelId, KIND),
    })
    if (label !== null) {
      labels.push({ id: label.id, name: label.name, color: label.color, idBoard: label.boardId })
    }
  }
  const members: JsonValue[] = []
  for (const memberId of memberIds) {
    const member = await db.trelloMember.findUnique({ where: memberWhere(tenant, memberId) })
    if (member !== null) {
      members.push({ id: member.id, username: member.username, fullName: member.fullName })
    }
  }
  const shortUrl = `https://trello.com/c/${card.id}`
  return {
    id: card.id,
    name: card.name,
    desc: card.desc,
    idBoard: list === null ? null : list.boardId,
    idList: card.listId,
    idMembers: memberIds,
    due: card.due,
    dueComplete: card.dueComplete,
    closed: card.closed,
    dateLastActivity: card.dateLastActivity,
    shortUrl,
    url: shortUrl,
    labels,
    members,
  }
}

export async function commentActions(db: C, tenant: string, cardId: string): Promise<JsonValue[]> {
  const comments = await db.trelloComment.findMany({
    where: { ...tenantWhere<Prisma.TrelloCommentWhereInput>(tenant, KIND), cardId },
    orderBy: { seq: 'asc' },
  })
  const rows: JsonValue[] = []
  for (const comment of comments) {
    const member =
      comment.memberId === null
        ? null
        : await db.trelloMember.findUnique({ where: memberWhere(tenant, comment.memberId) })
    rows.push({
      id: comment.id,
      type: 'commentCard',
      date: comment.date,
      memberCreator: {
        id: member?.id ?? null,
        fullName: member?.fullName ?? null,
        username: member?.username ?? null,
      },
      data: { text: comment.text, card: { id: cardId } },
    })
  }
  return rows
}

export async function nextSeq(rows: Promise<{ seq: number }[]>): Promise<number> {
  const existing = await rows
  return existing.reduce((acc, r) => Math.max(acc, r.seq + 1), 0)
}
