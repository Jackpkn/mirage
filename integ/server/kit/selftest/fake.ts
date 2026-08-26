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

import { Prisma, PrismaClient } from '../../../generated/selftest/index.js'
import { parseConfig } from '../typescript/config.ts'
import { schemaFor } from '../typescript/fixture.ts'
import { idWhere, tenantWhere } from '../typescript/tenant.ts'
import { route } from '../typescript/route.ts'
import type { Ctx, KitRoute } from '../typescript/route.ts'
import type { Fake } from '../typescript/base.ts'
import type { Dmmf } from '../typescript/seed.ts'
import type { JsonValue, Reply } from '../typescript/types.ts'

type C = PrismaClient

const config = parseConfig({
  service: 'selftest',
  schema: schemaFor('selftest'),
  tenantKind: 'pk-column',
  mintSharing: 'global',
  mintFormat: '{kind}_new_{n}',
})

function cardJson(row: {
  id: string
  title: string
  seq: number
  createdAt: string | null
}): JsonValue {
  return { id: row.id, title: row.title, seq: row.seq, createdAt: row.createdAt }
}

async function listBoards(ctx: Ctx<C>): Promise<Reply> {
  const rows = await ctx.db.board.findMany({
    where: tenantWhere(ctx.tenant, config.tenantKind),
    orderBy: { seq: 'asc' },
    include: { owner: true },
  })
  return {
    status: 200,
    body: {
      boards: rows.map((b) => ({
        id: b.id,
        name: b.name,
        seq: b.seq,
        owner: b.owner === null ? null : { id: b.owner.id, name: b.owner.name },
      })),
    },
  }
}

// The ordering trap, both ways. `cards` reads with the explicit seq order the
// seeder stamped; `cardsNaive` is the same relation read through `include`
// with no orderBy, which is what every fake did before and is the thing the
// selftest exists to show is not fixture order.
async function listCards(ctx: Ctx<C>): Promise<Reply> {
  const rows = await ctx.db.card.findMany({
    where: { ...tenantWhere(ctx.tenant, config.tenantKind), boardId: ctx.params.board ?? '' },
    orderBy: { seq: 'asc' },
  })
  return { status: 200, body: { cards: rows.map(cardJson) } }
}

async function listCardsNaive(ctx: Ctx<C>): Promise<Reply> {
  const board = await ctx.db.board.findUnique({
    where: idWhere<Prisma.BoardWhereUniqueInput>(
      ctx.tenant,
      ctx.params.board ?? '',
      config.tenantKind,
    ),
    include: { cards: true },
  })
  if (board === null) return { status: 404, body: { error: 'no_board' } }
  return { status: 200, body: { cards: board.cards.map(cardJson) } }
}

async function getCard(ctx: Ctx<C>): Promise<Reply> {
  const row = await ctx.db.card.findUnique({
    where: idWhere<Prisma.CardWhereUniqueInput>(
      ctx.tenant,
      ctx.params.card ?? '',
      config.tenantKind,
    ),
  })
  if (row === null) return { status: 404, body: { error: 'no_card' } }
  return { status: 200, body: cardJson(row) }
}

async function createCard(ctx: Ctx<C>): Promise<Reply> {
  const body = ctx.json()
  const title =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.title === 'string'
      ? body.title
      : 'untitled'
  const boardId = ctx.params.board ?? ''
  const seq = await ctx.db.card.count({
    where: { ...tenantWhere(ctx.tenant, config.tenantKind), boardId },
  })
  const row = await ctx.db.card.create({
    data: {
      tenant: ctx.tenant,
      id: ctx.minter.mint('crd'),
      boardId,
      title,
      seq,
      createdAt: ctx.clock.nowIso(),
    },
  })
  return { status: 201, body: cardJson(row) }
}

// A retitle done as delete + re-create, which is how several of the live
// fakes implement an update. It is also the shortest honest way to show the
// ordering trap: the row keeps its seq, so the ordered read is unchanged,
// while the naive `include` read moves it to the end because that is where
// SQLite put the new row.
async function retitleCard(ctx: Ctx<C>): Promise<Reply> {
  const body = ctx.json()
  const title =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.title === 'string'
      ? body.title
      : 'untitled'
  const where = idWhere<Prisma.CardWhereUniqueInput>(
    ctx.tenant,
    ctx.params.card ?? '',
    config.tenantKind,
  )
  const old = await ctx.db.card.findUnique({ where })
  if (old === null) return { status: 404, body: { error: 'no_card' } }
  await ctx.db.card.delete({ where })
  const row = await ctx.db.card.create({
    data: {
      tenant: old.tenant,
      id: old.id,
      boardId: old.boardId,
      title,
      seq: old.seq,
      createdAt: ctx.clock.nowIso(),
    },
  })
  return { status: 200, body: cardJson(row) }
}

export const selftestFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  defaultTenants: ['default'],
  routes: (): KitRoute<C>[] => [
    route('GET', '/boards', listBoards),
    route('GET', '/boards/:board/cards', listCards),
    route('GET', '/boards/:board/cards-naive', listCardsNaive),
    route('GET', '/cards/:card', getCard),
    route('POST', '/boards/:board/cards', createCard, { write: true }),
    route('PUT', '/cards/:card', retitleCard, { write: true }),
  ],
}
