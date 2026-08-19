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

import { describe, expect, it } from 'vitest'

import { CallbackApprover, RecordApprover, requestId } from './approver.ts'
import type { ApprovalDecision, ApprovalRequest, CommandRule } from './types.ts'

const RULE: CommandRule = { reason: 'sign-off', commands: ['git push'] }

async function request(
  words: readonly string[] = ['git', 'push'],
  cwd = '/repo',
  sessionId = 's',
): Promise<ApprovalRequest> {
  return {
    id: await requestId(sessionId, cwd, words),
    sessionId,
    agentId: '',
    command: words[0] ?? '',
    argv: words.slice(1),
    cwd,
    paths: [],
    reason: 'sign-off',
    rule: RULE,
  }
}

describe('requestId', () => {
  it('is a digest of what was asked, spelled as Python spells it', async () => {
    const same = await requestId('s', '/repo', ['git', 'push'])
    expect(same).toBe(await requestId('s', '/repo', ['git', 'push']))
    expect(same).toHaveLength(12)
    // sha1("s\0/repo\0git\0push\0")[:12], the value the Python request_id
    // computes for the same question (pinned in tests/policy/test_approver.py).
    expect(same).toBe('97702f321d7a')
    // Any of session, cwd or a word changes the question.
    expect(same).not.toBe(await requestId('t', '/repo', ['git', 'push']))
    expect(same).not.toBe(await requestId('s', '/scratch', ['git', 'push']))
    expect(same).not.toBe(await requestId('s', '/repo', ['git', 'pull']))
    // Words are delimited, so a boundary shift is not the same line.
    expect(await requestId('s', '/', ['ab', 'c'])).not.toBe(await requestId('s', '/', ['a', 'bc']))
  })
})

describe('RecordApprover', () => {
  it('records and answers pending', async () => {
    const approver = new RecordApprover()
    const first = await request()
    expect(await approver.approve(first)).toBeNull()
    expect(approver.pending()).toEqual([first])
    // A retry of the same line asks the same question: one entry, the
    // first request kept, oldest first.
    expect(await approver.approve(await request())).toBeNull()
    const other = await request(['git', 'push', '--force'])
    expect(await approver.approve(other)).toBeNull()
    expect(approver.pending()).toEqual([first, other])
    expect(approver.take(first.id)).toBe(first)
    expect(approver.pending()).toEqual([other])
    expect(() => approver.take(first.id)).toThrow(/no pending approval/)
  })
})

describe('CallbackApprover', () => {
  it('returns the host answer', async () => {
    const seen: ApprovalRequest[] = []
    const approver = new CallbackApprover((req): Promise<ApprovalDecision> => {
      seen.push(req)
      return Promise.resolve('allow_session')
    })
    const req = await request()
    expect(await approver.approve(req)).toBe('allow_session')
    expect(seen).toEqual([req])
  })

  it('denies on timeout', async () => {
    const approver = new CallbackApprover(
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          setTimeout(() => {
            resolve('allow_once')
          }, 10_000).unref()
        }),
      10,
    )
    expect(await approver.approve(await request())).toBe('deny')
  })
})
