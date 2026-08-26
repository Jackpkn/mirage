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

import { tenantWhere } from '../kit/typescript/tenant.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import type { Refs } from './nodes.ts'
import type { Team } from '../../generated/linear/index.js'

export interface TeamScoped {
  teamId: string
  seq: number
}

// Ordering is not free here: `include` and a bare findMany do not read back
// insertion order, so every read that a caller sees the order of goes through
// seq. The old fake's by-id dictionaries were in seed order, which is team
// order first and then position within the team, and two reads depend on it
// (UserLookup takes the first user with an email, IssueSearch fills its page
// in that order), so the global maps are rebuilt in exactly that order rather
// than in whatever order SQLite hands back.
export function byTeamThenSeq<T extends TeamScoped>(rows: T[], teamSeq: Map<string, number>): T[] {
  return [...rows].sort(
    (a, b) => (teamSeq.get(a.teamId) ?? 0) - (teamSeq.get(b.teamId) ?? 0) || a.seq - b.seq,
  )
}

export function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const row of rows) out.set(row.id, row)
  return out
}

export async function loadTeams(db: C, tenant: string): Promise<Team[]> {
  return db.team.findMany({
    where: tenantWhere(tenant, config.tenantKind),
    orderBy: { seq: 'asc' },
  })
}

// The next GLOBAL issue ordinal in the tenant. The seeder stamps seq per
// nested list, so afterSeed renumbers issues across teams and a create takes
// MAX + 1 from there; taking it per team would file a new issue among its own
// team's rows instead of at the end of the world, which is the order
// IssueSearch pages in.
export async function nextIssueSeq(db: C, tenant: string): Promise<number> {
  const top = await db.issue.aggregate({
    where: tenantWhere(tenant, config.tenantKind),
    _max: { seq: true },
  })
  return (top._max.seq ?? -1) + 1
}

export function teamSeqOf(teams: Team[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const team of teams) out.set(team.id, team.seq)
  return out
}

// One read of the five global tables per request. The data is small and the
// alternative is a findUnique per rendered reference, which is the N+1 the
// old fake avoided by holding everything in dicts.
export async function loadRefs(db: C, tenant: string): Promise<Refs> {
  const where = tenantWhere(tenant, config.tenantKind)
  const order = { orderBy: { seq: 'asc' } } as const
  const teams = await loadTeams(db, tenant)
  const teamSeq = teamSeqOf(teams)
  const [states, projects, cycles, users, labels] = await Promise.all([
    db.workflowState.findMany({ where, ...order }),
    db.project.findMany({ where, ...order }),
    db.cycle.findMany({ where, ...order }),
    db.user.findMany({ where, ...order }),
    db.label.findMany({ where, ...order }),
  ])
  return {
    teams: indexById(teams),
    states: indexById(byTeamThenSeq(states, teamSeq)),
    projects: indexById(byTeamThenSeq(projects, teamSeq)),
    cycles: indexById(byTeamThenSeq(cycles, teamSeq)),
    users: indexById(byTeamThenSeq(users, teamSeq)),
    labels: indexById(byTeamThenSeq(labels, teamSeq)),
  }
}

// issueId -> label ids in the order the issue holds them, duplicates kept.
// The surrogate pk on the link table is what allows the same label twice,
// and seq is what keeps the pair in the order it was written.
export async function loadLabelLinks(db: C, tenant: string): Promise<Map<string, string[]>> {
  const rows = await db.issueLabel.findMany({
    where: tenantWhere(tenant, config.tenantKind),
    orderBy: { seq: 'asc' },
  })
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const live = out.get(row.issueId)
    if (live === undefined) out.set(row.issueId, [row.labelId])
    else live.push(row.labelId)
  }
  return out
}

export function labelsOf(links: Map<string, string[]>, issueId: string): string[] {
  return links.get(issueId) ?? []
}

export async function writeLabelLinks(
  db: C,
  tenant: string,
  issueId: string,
  labelIds: string[],
): Promise<void> {
  await db.issueLabel.deleteMany({ where: { tenant, issueId } })
  for (const [seq, labelId] of labelIds.entries()) {
    await db.issueLabel.create({ data: { tenant, issueId, labelId, seq } })
  }
}
