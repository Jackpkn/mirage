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

import type { LinearAccessor } from '../../accessor/linear.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import {
  listIssueComments,
  listTeamCycles,
  listTeamDocuments,
  listTeamIssues,
  listTeamMembers,
  listTeamProjects,
  listTeams,
} from './client.ts'
import {
  buildProjectIssue,
  normalizeComment,
  normalizeCycle,
  normalizeDocument,
  normalizeIssue,
  normalizeProject,
  normalizeTeam,
  normalizeUser,
  toJsonBytes,
  type NormalizedProjectIssue,
} from './normalize.ts'
import {
  cycleFilename,
  documentFilename,
  issueDirname,
  memberFilename,
  projectFilename,
  teamDirname,
} from './pathing.ts'
import { detectScope } from './scope.ts'
import { jsonlBytesByCreatedAt } from '../render/json.ts'

export const TEAM_DIRS = ['members', 'issues', 'projects', 'cycles', 'documents'] as const

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

async function filteredTeams(accessor: LinearAccessor): Promise<Record<string, unknown>[]> {
  let teams = await listTeams(accessor.transport)
  if (accessor.teamIds !== null && accessor.teamIds.length > 0) {
    const allowed = new Set(accessor.teamIds)
    teams = teams.filter((t) => allowed.has(pickString(t, 'id')))
  }
  return teams
}

/**
 * The team the slots name, null when no listing carries it.
 *
 * Existence is proven against the team listing by the full `label__id`
 * dirname, never by calling the API with the typed id: a bogus id must read
 * as ENOENT, not as a Linear API error.
 */
export async function findTeam(
  accessor: LinearAccessor,
  slots: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  const target = `${slots.team ?? ''}__${slots.team_id ?? ''}`
  for (const team of await filteredTeams(accessor)) {
    if (teamDirname(team) === target) return team
  }
  return null
}

/** The issue the slots name, validated through its team. */
export async function findIssue(
  accessor: LinearAccessor,
  slots: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  if ((await findTeam(accessor, slots)) === null) return null
  const target = `${slots.issue ?? ''}__${slots.issue_id ?? ''}`
  for (const issue of await listTeamIssues(accessor.transport, slots.team_id ?? '')) {
    if (issueDirname(issue) === target) return issue
  }
  return null
}

async function listTeamsDir(
  accessor: LinearAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const entries: [string, IndexEntry][] = []
  for (const team of await filteredTeams(accessor)) {
    const dirname = teamDirname(team)
    entries.push([
      dirname,
      new IndexEntry({
        id: pickString(team, 'id'),
        name: pickString(team, 'name') || pickString(team, 'key') || pickString(team, 'id'),
        resourceType: 'linear/team',
        remoteTime: pickString(team, 'updatedAt'),
        vfsName: dirname,
        extra: {
          team_key: pickString(team, 'key'),
          team_name: pickString(team, 'name'),
          team_json_size: toJsonBytes(normalizeTeam(team)).length,
        },
      }),
    ])
  }
  return entries
}

async function listTeam(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const team = await findTeam(accessor, match.slots)
  if (team === null) return null
  const teamId = pickString(team, 'id')
  // team.json renders the team object this find already fetched, so its
  // exact size is free here.
  const entries: [string, IndexEntry][] = [
    [
      'team.json',
      new IndexEntry({
        id: teamId,
        name: 'team.json',
        resourceType: 'linear/team_json',
        remoteTime: pickString(team, 'updatedAt'),
        vfsName: 'team.json',
        size: toJsonBytes(normalizeTeam(team)).length,
      }),
    ],
  ]
  for (const name of TEAM_DIRS) {
    entries.push([
      name,
      new IndexEntry({
        id: teamId,
        name,
        resourceType: `linear/${name}_dir`,
        vfsName: name,
      }),
    ])
  }
  return entries
}

async function listMembers(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findTeam(accessor, match.slots)) === null) return null
  const users = await listTeamMembers(accessor.transport, match.slots.team_id ?? '')
  return users.map((user): [string, IndexEntry] => {
    const filename = memberFilename(user)
    return [
      filename,
      new IndexEntry({
        id: pickString(user, 'id'),
        name: pickString(user, 'name') || pickString(user, 'displayName') || pickString(user, 'id'),
        resourceType: 'linear/user',
        remoteTime: pickString(user, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(normalizeUser(user)).length,
      }),
    ]
  })
}

async function listIssues(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findTeam(accessor, match.slots)) === null) return null
  const issues = await listTeamIssues(accessor.transport, match.slots.team_id ?? '')
  return issues.map((issue): [string, IndexEntry] => {
    const dirname = issueDirname(issue)
    return [
      dirname,
      new IndexEntry({
        id: pickString(issue, 'id'),
        name: pickString(issue, 'identifier') || pickString(issue, 'id'),
        resourceType: 'linear/issue',
        remoteTime: pickString(issue, 'updatedAt'),
        vfsName: dirname,
        extra: {
          issue_key: pickString(issue, 'identifier'),
          issue_json_size: toJsonBytes(normalizeIssue(issue)).length,
        },
      }),
    ]
  })
}

async function listIssue(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const issue = await findIssue(accessor, match.slots)
  if (issue === null) return null
  // issue.json renders the issue this find already fetched; comments.jsonl
  // costs the one bounded comments call, paid only when this directory is
  // entered.
  const normalized = normalizeIssue(issue)
  const issueId = pickString(issue, 'id')
  const remoteTime = pickString(issue, 'updatedAt')
  const comments = await listIssueComments(accessor.transport, issueId)
  const rows = comments.map((c) => normalizeComment(c, issueId, normalized.issue_key))
  let commentsTime = ''
  for (const row of rows) {
    const updated = typeof row.updated_at === 'string' ? row.updated_at : ''
    if (updated > commentsTime) commentsTime = updated
  }
  return [
    [
      'issue.json',
      new IndexEntry({
        id: issueId,
        name: 'issue.json',
        resourceType: 'linear/issue_json',
        remoteTime,
        vfsName: 'issue.json',
        size: toJsonBytes(normalized).length,
      }),
    ],
    [
      'comments.jsonl',
      new IndexEntry({
        id: issueId,
        name: 'comments.jsonl',
        resourceType: 'linear/comments',
        remoteTime: commentsTime !== '' ? commentsTime : remoteTime,
        vfsName: 'comments.jsonl',
        size: jsonlBytesByCreatedAt(rows).length,
      }),
    ],
  ]
}

async function listProjects(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const team = await findTeam(accessor, match.slots)
  if (team === null) return null
  const teamId = match.slots.team_id ?? ''
  const projects = await listTeamProjects(accessor.transport, teamId)
  const teamIssues = await listTeamIssues(accessor.transport, teamId)
  return projects.map((project): [string, IndexEntry] => {
    const projectId = pickString(project, 'id')
    const projectIssues: NormalizedProjectIssue[] = []
    for (const issue of teamIssues) {
      const projField = issue.project
      const projObj =
        projField !== null && typeof projField === 'object'
          ? (projField as Record<string, unknown>)
          : {}
      if (projObj.id !== projectId) continue
      projectIssues.push(buildProjectIssue(issue))
    }
    const rendered = normalizeProject(project, {
      teamId,
      teamKey: pickString(team, 'key') || null,
      teamName: pickString(team, 'name') || null,
      issues: projectIssues,
    })
    const filename = projectFilename(project)
    return [
      filename,
      new IndexEntry({
        id: projectId,
        name: pickString(project, 'name') || projectId,
        resourceType: 'linear/project',
        remoteTime: pickString(project, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(rendered).length,
      }),
    ]
  })
}

async function listCycles(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findTeam(accessor, match.slots)) === null) return null
  const teamId = match.slots.team_id ?? ''
  const cycles = await listTeamCycles(accessor.transport, teamId)
  return cycles.map((cycle): [string, IndexEntry] => {
    const filename = cycleFilename(cycle)
    return [
      filename,
      new IndexEntry({
        id: pickString(cycle, 'id'),
        name: pickString(cycle, 'name') || pickString(cycle, 'id'),
        resourceType: 'linear/cycle',
        remoteTime: pickString(cycle, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(normalizeCycle(cycle, teamId)).length,
      }),
    ]
  })
}

async function listDocuments(
  accessor: LinearAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findTeam(accessor, match.slots)) === null) return null
  const documents = await listTeamDocuments(accessor.transport, match.slots.team_id ?? '')
  return documents.map((document): [string, IndexEntry] => {
    const filename = documentFilename(document)
    return [
      filename,
      new IndexEntry({
        id: pickString(document, 'id'),
        name: pickString(document, 'title') || pickString(document, 'id'),
        resourceType: 'linear/document',
        remoteTime: pickString(document, 'updatedAt'),
        vfsName: filename,
        size: toJsonBytes(normalizeDocument(document)).length,
      }),
    ]
  })
}

export const readdir = makeReaddir<LinearAccessor>(detectScope, {
  listers: {
    teams: listTeamsDir,
    team: listTeam,
    members: listMembers,
    issues: listIssues,
    issue: listIssue,
    projects: listProjects,
    cycles: listCycles,
    documents: listDocuments,
  },
  staticRoot: ['teams'],
})
