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
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_DATE } from './date.ts'

const DEC = new TextDecoder()

async function runDate(
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const resource = new RAMResource()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('date', () => {
  it('-I returns ISO date', async () => {
    const fixed = '2026-04-21T12:00:00Z'
    const out = await runDate([], { d: fixed, args_I: true })
    expect(out).toBe('2026-04-21\n')
  })

  it('-d with custom format', async () => {
    const out = await runDate(['+%Y-%m-%d'], { d: '2026-04-21T12:00:00Z', u: true })
    expect(out).toBe('2026-04-21\n')
  })

  it('+%H:%M:%S UTC', async () => {
    const out = await runDate(['+%H:%M:%S'], { d: '2026-04-21T13:45:30Z', u: true })
    expect(out).toBe('13:45:30\n')
  })

  it('default format roughly matches "Day Mon DD HH:MM:SS YYYY"', async () => {
    const out = await runDate([], { d: '2026-04-21T12:00:00', u: true })
    // Tue Apr 21 12:00:00 UTC 2026
    expect(out).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} (UTC )?2026\n$/)
  })

  it('-R RFC5322 format', async () => {
    const out = await runDate([], { d: '2026-04-21T12:00:00Z', u: true, R: true })
    expect(out).toBe('Tue, 21 Apr 2026 12:00:00 +0000\n')
  })

  it('+%s seconds since epoch', async () => {
    const out = await runDate(['+%s'], { d: '2026-04-21T00:00:00Z', u: true })
    // 2026-04-21T00:00:00Z = 1777305600
    expect(out.trim()).toBe(String(Math.floor(Date.UTC(2026, 3, 21) / 1000)))
  })
})

async function runDateIo(
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<[string, string, number]> {
  const resource = new RAMResource()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return ['', '', 0]
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const errRaw =
    io.stderr === null
      ? new Uint8Array()
      : io.stderr instanceof Uint8Array
        ? io.stderr
        : await materialize(io.stderr as AsyncIterable<Uint8Array>)
  return [DEC.decode(buf), DEC.decode(errRaw), io.exitCode]
}

describe('date GNU format specifiers', () => {
  const AT = '2026-08-16T13:45:30Z'

  it('+%F renders the ISO date, not the literal', async () => {
    expect(await runDate(['+%F %T'], { d: AT, u: true })).toBe('2026-08-16 13:45:30\n')
  })

  it('renders 12-hour, quarter, century, and padded-hour forms', async () => {
    expect(await runDate(['+%r|%q|%C|%h|%k|%l|%P|%R'], { d: AT, u: true })).toBe(
      '01:45:30 PM|3|20|Aug|13| 1|pm|13:45\n',
    )
  })

  it('renders week numbers and the ISO week-based year', async () => {
    expect(await runDate(['+%V|%U|%W|%G|%g'], { d: AT, u: true })).toBe('33|33|32|2026|26\n')
  })

  it('renders C-locale %c, %x, %X and the %n/%t escapes', async () => {
    expect(await runDate(['+%c|%x|%X|%n|%t'], { d: AT, u: true })).toBe(
      'Sun Aug 16 13:45:30 2026|08/16/26|13:45:30|\n|\t\n',
    )
  })

  it('passes an unknown directive through literally, as GNU does', async () => {
    expect(await runDate(['+%v'], { d: AT, u: true })).toBe('%v\n')
  })
})

describe('date -d expressions', () => {
  it('handles a relative displacement from an ISO base', async () => {
    const out = await runDate(['+%F %T'], { d: '2026-08-16 12:00:00 24 hours ago', u: true })
    expect(out).toBe('2026-08-15 12:00:00\n')
  })

  it('handles @epoch input', async () => {
    expect(await runDate(['+%F %T'], { d: '@1755300000', u: true })).toBe('2025-08-15 23:20:00\n')
  })

  it('normalizes month overflow the way GNU does', async () => {
    expect(await runDate(['+%F'], { d: '2026-01-31 1 month', u: true })).toBe('2026-03-03\n')
  })

  it('produces a date, never NaN, for a bare relative expression', async () => {
    const out = await runDate(['+%F'], { d: '24 hours ago', u: true })
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\n$/)
  })

  it('refuses an invalid date with GNU wording and exit 1', async () => {
    const [out, stderr, code] = await runDateIo([], { d: 'not a date' })
    expect(out).toBe('')
    expect(stderr).toBe("date: invalid date 'not a date'\n")
    expect(code).toBe(1)
  })
})
