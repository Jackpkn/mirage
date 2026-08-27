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

import type {
  Comment,
  Cycle,
  Document,
  Issue,
  Label,
  Project,
  Team,
  User,
  WorkflowState,
} from '../../generated/linear/index.js'
import type { JsonValue } from '../kit/typescript/types.ts'
import { pyKey, pyList } from './pyval.ts'
import { readRaw, refValue, verbatim } from './raw.ts'

// The reference maps. Every one of these entities lived in a single by-id
// dictionary in the old fake, shared by both teams, so a lookup here is
// global on purpose: an issue on WEB pointing at a PLAT state renders that
// state, and a reference to nothing renders null rather than failing.
export interface Refs {
  teams: Map<string, Team>
  states: Map<string, WorkflowState>
  projects: Map<string, Project>
  cycles: Map<string, Cycle>
  users: Map<string, User>
  labels: Map<string, Label>
}

export const EMPTY_PAGE: JsonValue = { hasNextPage: false, endCursor: null }

export function connection(nodes: JsonValue[]): JsonValue {
  return { nodes, pageInfo: { ...(EMPTY_PAGE as Record<string, JsonValue>) } }
}

export function identifierNumber(identifier: string | null): number {
  if (identifier === null || !identifier.includes('-')) return 0
  const tail = identifier.slice(identifier.lastIndexOf('-') + 1)
  return /^[0-9]+$/.test(tail) ? Number(tail) : 0
}

export function teamRef(refs: Refs, teamId: string | null): JsonValue {
  const team = teamId === null ? undefined : refs.teams.get(teamId)
  if (team === undefined) return null
  return { id: team.id, key: team.key, name: team.name }
}

export function stateRef(refs: Refs, stateId: string | null): JsonValue {
  const state = stateId === null ? undefined : refs.states.get(stateId)
  if (state === undefined) return null
  return { id: state.id, name: state.name }
}

export function projectRef(refs: Refs, projectId: string | null): JsonValue {
  const project = projectId === null ? undefined : refs.projects.get(projectId)
  if (project === undefined) return null
  return { id: project.id, name: project.name }
}

export function cycleRef(refs: Refs, cycleId: string | null): JsonValue {
  const cycle = cycleId === null ? undefined : refs.cycles.get(cycleId)
  if (cycle === undefined) return null
  return { id: cycle.id, name: cycle.name, number: cycle.number }
}

// Two different projections of a user, kept apart because the live fake kept
// them apart: an issue's assignee and creator carry no displayName, a
// comment's author does.
export function personRef(refs: Refs, userId: string | null): JsonValue {
  const user = userId === null ? undefined : refs.users.get(userId)
  if (user === undefined) return null
  return { id: user.id, name: user.name, email: user.email }
}

export function userRef(refs: Refs, userId: string | null): JsonValue {
  const user = userId === null ? undefined : refs.users.get(userId)
  if (user === undefined) return null
  return { id: user.id, name: user.name, displayName: user.displayName, email: user.email }
}

// An unknown label id is skipped, not rendered as null, and the list keeps
// duplicates: it is the stored order of the issue's label list, whatever is
// in it. An id that is not a string misses rather than matching, and one that
// cannot be hashed raises, because the old fake looked each one up in a dict.
export function labelRefs(refs: Refs, labelIds: JsonValue[]): JsonValue[] {
  const out: JsonValue[] = []
  for (const labelId of labelIds) {
    const key = pyKey(labelId)
    const label = typeof key === 'string' ? refs.labels.get(key) : undefined
    if (label !== undefined) out.push({ id: label.id, name: label.name })
  }
  return out
}

// issueUpdate assigns labelIds verbatim, so the stored value may be any JSON
// and the render is the one that iterates it.
function labelList(map: Record<string, JsonValue>, stored: string[]): JsonValue[] {
  return 'labelIds' in map ? pyList(map.labelIds) : stored
}

export function teamNode(team: Team, states: WorkflowState[]): JsonValue {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description,
    timezone: team.timezone,
    updatedAt: team.updatedAt,
    states: { nodes: states.map((s) => ({ id: s.id, name: s.name, type: s.type })) },
  }
}

export function userNode(user: User): JsonValue {
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName,
    email: user.email,
    active: user.active,
    admin: user.admin,
    url: user.url,
    updatedAt: user.updatedAt,
  }
}

export function issueNode(refs: Refs, issue: Issue, labelIds: string[]): JsonValue {
  const map = readRaw(issue.raw)
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: verbatim(map, 'title', issue.title),
    description: verbatim(map, 'description', issue.description),
    priority: verbatim(map, 'priority', issue.priority),
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    team: teamRef(refs, issue.teamId),
    state: stateRef(refs, refValue(map, 'stateId', issue.stateId)),
    project: projectRef(refs, refValue(map, 'projectId', issue.projectId)),
    cycle: cycleRef(refs, refValue(map, 'cycleId', issue.cycleId)),
    assignee: personRef(refs, refValue(map, 'assigneeId', issue.assigneeId)),
    creator: personRef(refs, refValue(map, 'creatorId', issue.creatorId)),
    labels: { nodes: labelRefs(refs, labelList(map, labelIds)) },
  }
}

// The haystack IssueSearch matches on, built the way the old fake built it:
// three fields joined with a space, each one falling back to "" when it is
// falsy and raising when it is truthy and not a string.
export function issueTitle(issue: Issue): JsonValue {
  return verbatim(readRaw(issue.raw), 'title', issue.title)
}

export function issueDescription(issue: Issue): JsonValue {
  return verbatim(readRaw(issue.raw), 'description', issue.description)
}

export function projectNode(project: Project): JsonValue {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: { type: project.statusType },
    url: project.url,
    updatedAt: project.updatedAt,
    lead: project.leadId === null ? null : { id: project.leadId },
  }
}

export function cycleNode(cycle: Cycle): JsonValue {
  return {
    id: cycle.id,
    name: cycle.name,
    number: cycle.number,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    updatedAt: cycle.updatedAt,
  }
}

export function labelNode(label: Label): JsonValue {
  return { id: label.id, name: label.name, color: label.color }
}

export function documentNode(refs: Refs, document: Document): JsonValue {
  return {
    id: document.id,
    title: document.title,
    content: document.content,
    url: document.url,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    project: projectRef(refs, document.projectId),
    creator: personRef(refs, document.creatorId),
  }
}

export function commentNode(refs: Refs, comment: Comment): JsonValue {
  return {
    id: comment.id,
    body: verbatim(readRaw(comment.raw), 'body', comment.body),
    url: comment.url,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    user: userRef(refs, comment.userId),
  }
}

// searchIssues renders a third user projection and a state ref, and nothing
// else: it is the only read whose node is not one of the ones above.
export function searchNode(refs: Refs, issue: Issue): JsonValue {
  const map = readRaw(issue.raw)
  const assigneeId = refValue(map, 'assigneeId', issue.assigneeId)
  const user = assigneeId === null ? undefined : refs.users.get(assigneeId)
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: verbatim(map, 'title', issue.title),
    state: stateRef(refs, refValue(map, 'stateId', issue.stateId)),
    assignee:
      user === undefined ? null : { id: user.id, displayName: user.displayName, email: user.email },
    url: issue.url,
  }
}
