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

import { createHash } from 'node:crypto'
import type { JsonValue } from '../kit/typescript/index.ts'
import { DEFAULT_LOGIN, ROOT_COMMIT_DATE } from './config.ts'

// Real git object ids, so shas look plausible and stay stable across runs.
export function blobSha(data: Uint8Array): string {
  const header = Buffer.from(`blob ${String(data.length)}\0`, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([header, Buffer.from(data)]))
    .digest('hex')
}

export function treeSha(path: string): string {
  return createHash('sha1').update(`tree\0${path}`, 'utf8').digest('hex')
}

export function commitSha(path: string): string {
  return createHash('sha1').update(`commit\0${path}`, 'utf8').digest('hex')
}

export function commitPerson(name: string, when: string): JsonValue {
  const handle = name.toLowerCase().replace(/ /g, '-')
  return { name, email: `${handle}@users.noreply.github.com`, date: when }
}

// The store keeps a commit's paths as strings, because that is all a write
// knows; the endpoints that report what changed answer with objects.
export function commitFiles(paths: string[], status = 'added'): JsonValue {
  return paths.map((filename) => ({ filename, status }))
}

export interface CommitRow {
  sha: string
  message: string
  authorLogin: string
  date: string
  filesJson: string
  treeSha: string
  seq: number
}

export function pathsOf(row: { filesJson: string }): string[] {
  const parsed = JSON.parse(row.filesJson) as JsonValue
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
}

// A stored commit as the LIST endpoints report it. GitHub's list and write
// shapes carry no `files` key at all; serving one handed clients bare strings
// where the contract has objects, which broke history enumeration after the
// first write.
export function commitJson(row: CommitRow): JsonValue {
  return {
    sha: row.sha,
    commit: {
      message: row.message,
      author: commitPerson(row.authorLogin, row.date),
      committer: commitPerson(row.authorLogin, row.date),
    },
    author: { login: row.authorLogin },
  }
}

// A write records a commit whose stored shape carries only a message, so its
// rendering omits the author blocks the seeded ones have. Kept apart rather
// than defaulted, because a golden renders the difference.
export function writtenCommitJson(row: { sha: string; message: string }): JsonValue {
  return { sha: row.sha, commit: { message: row.message } }
}

export function rootCommit(tree: Array<[string, string]>): CommitRow {
  const sorted = [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    sha: commitSha(`root\0${sorted.map(([p, b]) => `${p}:${b}`).join('\0')}`),
    message: 'Initial commit',
    authorLogin: 'mirage',
    date: ROOT_COMMIT_DATE,
    filesJson: '[]',
    treeSha: '',
    seq: -1,
  }
}

export function errorBody(message: string): JsonValue {
  return { message, documentation_url: 'https://docs.github.com/rest' }
}

export const DEFAULT_USER = DEFAULT_LOGIN
