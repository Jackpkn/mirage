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

import { Prisma, PrismaClient } from '../../generated/trello/index.js'
import { tenantWhere } from '../kit/typescript/index.ts'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import { trelloRoutes } from './routes.ts'
import { memberWhere } from './views.ts'

// seedFixture returns its counts sorted so the /reset body is byte-stable, and
// a row this hook adds after the fact would land at the end of that order. The
// caller holds this exact object, so it is re-sorted in place rather than
// replaced.
function resort(counts: Record<string, number>): void {
  const sorted = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))
  for (const key of Object.keys(counts)) delete counts[key]
  for (const [key, value] of sorted) counts[key] = value
}

// Board membership is stated per board in the fixture and the same person sits
// on two of them, so the global member table an id lookup reads is derived
// from the link rows rather than restated. Upserting in pk order keeps the
// last statement of a person's name, which is what the hand-written seeder's
// upsert-per-occurrence did.
//
// The derived rows are counted into the seed report too. seedFixture can only
// count what it creates, so without this the one model no fixture key names
// read back as an empty table in the /reset body.
async function deriveMembers(db: C, tenant: string, counts: Record<string, number>): Promise<void> {
  const links = await db.trelloBoardMember.findMany({
    where: tenantWhere<Prisma.TrelloBoardMemberWhereInput>(tenant, config.tenantKind),
    orderBy: { pk: 'asc' },
  })
  const seen = new Set<string>()
  for (const link of links) {
    await db.trelloMember.upsert({
      where: memberWhere(tenant, link.id),
      update: { username: link.username, fullName: link.fullName },
      create: { tenant, id: link.id, username: link.username, fullName: link.fullName },
    })
    seen.add(link.id)
  }
  if (seen.size > 0) {
    counts.TrelloMember = seen.size
    resort(counts)
  }
}

export const trelloFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  // `workspaces` de-pluralizes to `workspace`, which no model is called: the
  // models carry the vendor prefix the shared schema needed and kept.
  seedRoots: { workspaces: 'TrelloWorkspace' },
  afterSeed: deriveMembers,
  routes: trelloRoutes,
}
