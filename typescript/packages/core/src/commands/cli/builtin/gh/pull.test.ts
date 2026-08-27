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

import { describe, expect, it, vi } from 'vitest'
import type * as AccessorModule from './accessor.ts'
import type * as PullModule from '../../../../core/github/pull.ts'
import type { CLIInvocation } from '../../types.ts'

let ROWS: Record<string, unknown>[] = []

vi.mock('./accessor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AccessorModule>()
  return { ...actual, ghTransport: () => ({}) }
})

vi.mock('../../../../core/github/pull.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PullModule>()
  return { ...actual, pullChecks: () => Promise.resolve(ROWS) }
})

const { checksCmd } = await import('./pull.ts')

function inv(flags: CLIInvocation['flags'] = {}): CLIInvocation {
  return {
    config: { token: 't' },
    argv: [],
    paths: [],
    texts: ['5'],
    flags: { repo: 'o/r', ...flags },
    stdin: null,
    env: {},
  }
}

async function bucketOf(row: Record<string, unknown>): Promise<unknown> {
  ROWS = [{ name: 't', ...row }]
  const result = await checksCmd(inv({ json: 'name,bucket' }))
  if (result === null) throw new Error('expected a result tuple')
  const parsed = JSON.parse(new TextDecoder().decode(result[0] as Uint8Array)) as {
    bucket: unknown
  }[]
  return parsed[0]?.bucket
}

describe('gh pr checks buckets', () => {
  it.each([
    ['success', 'pass'],
    ['neutral', 'skipping'],
    ['skipped', 'skipping'],
    ['failure', 'fail'],
    ['error', 'fail'],
    ['timed_out', 'fail'],
    ['action_required', 'fail'],
    ['cancelled', 'cancel'],
    ['stale', 'pending'],
  ])('buckets the %s conclusion the way gh buckets it', async (conclusion, bucket) => {
    expect(await bucketOf({ conclusion })).toBe(bucket)
  })

  it.each(['queued', 'in_progress', 'pending', 'requested', 'waiting'])(
    'treats the %s status as pending',
    async (status) => {
      expect(await bucketOf({ status })).toBe('pending')
    },
  )

  it('treats an unknown state as pending rather than failed', async () => {
    expect(await bucketOf({ conclusion: 'invented' })).toBe('pending')
  })

  it('does not fail the command for a cancelled check', async () => {
    ROWS = [{ name: 't', conclusion: 'cancelled' }]
    const result = await checksCmd(inv())
    expect(result?.[1].exitCode ?? 0).toBe(0)
  })

  it('still exits one for a failing check', async () => {
    ROWS = [{ name: 't', conclusion: 'failure' }]
    const result = await checksCmd(inv())
    expect(result?.[1].exitCode).toBe(1)
  })
})
