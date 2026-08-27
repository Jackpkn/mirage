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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { FIXTURE_ROOT } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { commitSha } from './wire.ts'
import { allRepos } from './store.ts'
import type { RepoRow } from './store.ts'

// A fixture root file naming submodule gitlink paths, one per line. It is a
// manifest rather than repository content, so it never becomes a GithubFile.
const SUBMODULES = 'SUBMODULES'

function walkFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) visit(full)
      else out.push(full)
    }
  }
  visit(root)
  return out.sort()
}

// The per-repository collections a fresh fake starts with. They were literals
// in the python FakeRepo's constructor, so they are the same for every
// repository and no fixture states them; stating them here keeps them one
// declaration rather than one per fixture.
interface WorkflowSeed {
  id: number
  name: string
  path: string
  state: string
}

interface CheckSeed {
  id: number
  name: string
  status: string
  conclusion: string
  startedAt: string
  completedAt: string
  detailsUrl: string
  summary: string
}

interface StatusSeed {
  context: string
  state: string
  targetUrl: string
  description: string
  createdAt: string
  updatedAt: string
}

interface RunSeed {
  id: number
  name: string
  displayTitle: string
  workflowId: number
  runNumber: number
  runAttempt: number
  event: string
  headBranch: string
  headSha: string
  status: string
  conclusion: string
  createdAt: string
  updatedAt: string
  runStartedAt: string
}

function defaultWorkflows(): WorkflowSeed[] {
  return [
    { id: 102, name: 'Archive', path: '.github/workflows/archive.yml', state: 'disabled_manually' },
    { id: 101, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  ]
}

function defaultChecks(): CheckSeed[] {
  return [
    {
      id: 301,
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      detailsUrl: 'https://example.test/check/301',
      summary: 'All checks passed',
    },
    {
      id: 302,
      name: 'flaky',
      status: 'completed',
      conclusion: 'cancelled',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:02:00Z',
      detailsUrl: 'https://example.test/check/302',
      summary: 'Cancelled by a newer run',
    },
  ]
}

function defaultStatuses(): StatusSeed[] {
  return [
    {
      context: 'ci/legacy',
      state: 'success',
      targetUrl: 'https://example.test/status/legacy',
      description: 'Legacy status passed',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:01:30Z',
    },
  ]
}

function defaultRun(repo: RepoRow): RunSeed {
  return {
    id: 201,
    name: 'CI',
    displayTitle: 'Initial checks',
    workflowId: 101,
    runNumber: 1,
    runAttempt: 1,
    event: 'push',
    headBranch: repo.defaultBranch,
    headSha: commitSha('initial-run'),
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    runStartedAt: '2026-01-01T00:00:05Z',
  }
}

async function loadTree(db: C, tenant: string, repo: RepoRow): Promise<number> {
  if (repo.sourceDir === '') return 0
  const root = join(FIXTURE_ROOT, ...repo.sourceDir.split('/'))
  const branch = repo.sourceBranch === '' ? repo.defaultBranch : repo.sourceBranch
  let seq = 0
  let subs = 0
  for (const full of walkFiles(root)) {
    const rel = relative(root, full).split(sep).join('/')
    if (rel === SUBMODULES) {
      const lines = readFileSync(full, 'utf8').split('\n')
      for (const line of lines) {
        const path = line.trim()
        if (path === '') continue
        await db.githubSubmodule.create({ data: { tenant, repo: repo.fullName, path } })
        subs += 1
      }
      continue
    }
    await db.githubFile.create({
      data: { tenant, repo: repo.fullName, branch, path: rel, data: readFileSync(full), seq },
    })
    seq += 1
  }
  return seq + subs
}

// What a fixture cannot state: a repository's 120 files come from the directory
// its row names, and every repository starts with the same workflows, checks,
// statuses and one run. Both are counted into the /reset report, because a
// table no fixture key names would otherwise read back as empty.
export async function seedRepos(
  db: C,
  tenant: string,
  counts: Record<string, number>,
): Promise<void> {
  const repos = await allRepos(db, tenant)
  let files = 0
  let workflows = 0
  let checks = 0
  let statuses = 0
  let runs = 0
  for (const repo of repos) {
    files += await loadTree(db, tenant, repo)
    let seq = 0
    for (const row of defaultWorkflows()) {
      await db.githubWorkflow.create({ data: { tenant, repo: repo.fullName, ...row, seq } })
      seq += 1
      workflows += 1
    }
    seq = 0
    for (const row of defaultChecks()) {
      await db.githubCheck.create({ data: { tenant, repo: repo.fullName, ...row, seq } })
      seq += 1
      checks += 1
    }
    seq = 0
    for (const row of defaultStatuses()) {
      await db.githubStatus.create({ data: { tenant, repo: repo.fullName, ...row, seq } })
      seq += 1
      statuses += 1
    }
    await db.githubRun.create({
      data: { tenant, repo: repo.fullName, ...defaultRun(repo), seq: 0 },
    })
    runs += 1
  }
  const added: Record<string, number> = {
    GithubFile: files,
    GithubWorkflow: workflows,
    GithubCheck: checks,
    GithubStatus: statuses,
    GithubRun: runs,
  }
  for (const [model, n] of Object.entries(added)) if (n > 0) counts[model] = n
  const sorted = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))
  for (const key of Object.keys(counts)) delete counts[key]
  for (const [key, value] of sorted) counts[key] = value
}

export async function createReposAllowed(db: C, tenant: string): Promise<boolean> {
  const row = await db.githubSetting.findUnique({ where: { tenant } })
  return row === null || row.createRepos
}
