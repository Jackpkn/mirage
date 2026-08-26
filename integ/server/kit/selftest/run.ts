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

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../typescript/announce.ts'
import { unroutedLine } from '../typescript/unrouted.ts'
import type { JsonValue } from '../typescript/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..', '..')

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
  stderr: () => string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('='), stderr: () => err }
}

interface CallOpts {
  method?: string
  body?: JsonValue
  run?: string
  tenant?: string
}

async function call(
  fake: Fake,
  path: string,
  opts: CallOpts = {},
): Promise<{ status: number; json: JsonValue }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.run !== undefined) headers['x-mirage-run'] = opts.run
  if (opts.tenant !== undefined) headers['x-mirage-tenant'] = opts.tenant
  const res = await fetch(`${fake.endpoint}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as JsonValue) }
}

function titles(payload: JsonValue): string[] {
  const cards = (payload as { cards: { title: string }[] }).cards
  return cards.map((c) => c.title)
}

function rowsOf(payload: JsonValue, tenant: string): JsonValue {
  const seeded = (payload as { seeded: { tenant: string; rows: JsonValue }[] }).seeded
  const hit = seeded.find((s) => s.tenant === tenant)
  return hit === undefined ? null : hit.rows
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    process.stdout.write('\n1. announce + reachable\n')
    check(
      'endpoint is an origin with no path',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(fake.endpoint),
      fake.endpoint,
    )

    process.stdout.write('\n2. health\n')
    const health = await call(fake, '/_kit/health')
    check('GET /_kit/health is 200', health.status === 200, JSON.stringify(health.json))

    process.stdout.write('\n3. run isolation\n')
    const ra = await call(fake, '/reset', { method: 'POST', body: { run: 'a' } })
    const rb = await call(fake, '/reset', { method: 'POST', body: { run: 'b' } })
    check('reset a is 200', ra.status === 200, JSON.stringify(ra.json))
    check('reset b is 200', rb.status === 200, JSON.stringify(rb.json))
    const wrote = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'a',
      body: { title: 'written-into-a' },
    })
    check('write into run a is 201', wrote.status === 201, JSON.stringify(wrote.json))
    const inA = await call(fake, '/boards/brd_1/cards', { run: 'a' })
    const inB = await call(fake, '/boards/brd_1/cards', { run: 'b' })
    eq('run a sees the write', titles(inA.json) as unknown as JsonValue, [
      'zebra',
      'apple',
      'mango',
      'written-into-a',
    ])
    eq('run b does NOT see it', titles(inB.json) as unknown as JsonValue, [
      'zebra',
      'apple',
      'mango',
    ])

    process.stdout.write('\n4. two tenants, one run, same fixture ids\n')
    const rc = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'c', tenants: ['s1', 's2'] },
    })
    check('reset with two tenants is 200', rc.status === 200, JSON.stringify(rc.json))
    const s1 = await call(fake, '/cards/crd_a', { run: 'c', tenant: 's1' })
    const s2 = await call(fake, '/cards/crd_a', { run: 'c', tenant: 's2' })
    check('tenant s1 has crd_a', s1.status === 200, JSON.stringify(s1.json))
    check('tenant s2 has the SAME id crd_a', s2.status === 200, JSON.stringify(s2.json))
    const w1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'c',
      tenant: 's1',
      body: { title: 'only-in-s1' },
    })
    check('write into tenant s1 is 201', w1.status === 201, JSON.stringify(w1.json))
    eq(
      'tenant s2 is unaffected',
      titles(
        (await call(fake, '/boards/brd_1/cards', { run: 'c', tenant: 's2' })).json,
      ) as unknown as JsonValue,
      ['zebra', 'apple', 'mango'],
    )

    process.stdout.write('\n5. generic seeder, zero per-entity code\n')
    eq('seeded row counts for s1', rowsOf(rc.json, 's1'), { Board: 2, Card: 3, Owner: 1 })
    eq('seeded row counts for s2', rowsOf(rc.json, 's2'), { Board: 2, Card: 3, Owner: 1 })
    const boards = await call(fake, '/boards', { run: 'c', tenant: 's2' })
    eq(
      'nested single-object child (owner) landed',
      ((boards.json as { boards: { owner: JsonValue }[] }).boards[0] as { owner: JsonValue }).owner,
      { id: 'own_1', name: 'Ada Lovelace' },
    )

    process.stdout.write('\n6. fixture order (the include ordering trap)\n')
    const fresh = titles((await call(fake, '/boards/brd_1/cards-naive', { run: 'b' })).json)
    process.stdout.write(`       fresh seed, include with NO orderBy -> ${JSON.stringify(fresh)}\n`)
    const retitled = await call(fake, '/cards/crd_a', {
      method: 'PUT',
      run: 'b',
      body: { title: 'apricot' },
    })
    check(
      'retitle (delete + re-create) is 200',
      retitled.status === 200,
      JSON.stringify(retitled.json),
    )
    const naiveTitles = titles((await call(fake, '/boards/brd_1/cards-naive', { run: 'b' })).json)
    const seqTitles = titles((await call(fake, '/boards/brd_1/cards', { run: 'b' })).json)
    process.stdout.write(
      `       after write, include with NO orderBy -> ${JSON.stringify(naiveTitles)}\n`,
    )
    process.stdout.write(
      `       after write, findMany orderBy seq    -> ${JSON.stringify(seqTitles)}\n`,
    )
    check(
      'the naive include read LOST fixture order (trap reproduced)',
      JSON.stringify(naiveTitles) !== JSON.stringify(['zebra', 'apricot', 'mango']),
      JSON.stringify(naiveTitles),
    )
    eq('seq + orderBy still reads back fixture order', seqTitles as unknown as JsonValue, [
      'zebra',
      'apricot',
      'mango',
    ])

    process.stdout.write('\n7. mint + clock determinism across reset\n')
    const epoch = '2026-01-01T00:00:00Z'
    await call(fake, '/reset', { method: 'POST', body: { run: 'd', epoch } })
    const first1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'one' },
    })
    const first2 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'two' },
    })
    await call(fake, '/reset', { method: 'POST', body: { run: 'd', epoch } })
    const again1 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'one' },
    })
    const again2 = await call(fake, '/boards/brd_1/cards', {
      method: 'POST',
      run: 'd',
      body: { title: 'two' },
    })
    eq('first mint + clock', first1.json, {
      id: 'crd_new_1',
      title: 'one',
      seq: 3,
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    eq('second mint + clock', first2.json, {
      id: 'crd_new_2',
      title: 'two',
      seq: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    eq('same after reset (1)', again1.json, first1.json)
    eq('same after reset (2)', again2.json, first2.json)

    process.stdout.write('\n8. unrouted\n')
    const miss = await call(fake, '/no/such/thing')
    check('unrouted path is 404', miss.status === 404, JSON.stringify(miss.json))
    await new Promise((r) => setTimeout(r, 100))
    const want = unroutedLine('selftest', 'GET', '/no/such/thing')
    check('unrouted printed the stderr line', fake.stderr().includes(want), want)

    process.stdout.write('\n9. write serialization (per-run queue)\n')
    await call(fake, '/reset', { method: 'POST', body: { run: 'e' } })
    const burst = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        call(fake, '/boards/brd_2/cards', {
          method: 'POST',
          run: 'e',
          body: { title: `burst-${String(n)}` },
        }),
      ),
    )
    const seqs = burst.map((b) => (b.json as { seq: number }).seq).sort((a, b) => a - b)
    process.stdout.write(`       five concurrent POSTs -> seq ${JSON.stringify(seqs)}\n`)
    eq('concurrent writes got distinct seqs', seqs as unknown as JsonValue, [0, 1, 2, 3, 4])
    const ids = burst.map((b) => (b.json as { id: string }).id).sort()
    eq('and distinct minted ids', ids as unknown as JsonValue, [
      'crd_new_1',
      'crd_new_2',
      'crd_new_3',
      'crd_new_4',
      'crd_new_5',
    ])

    process.stdout.write('\n10. /reset refuses what it cannot interpret\n')
    const badField = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'f', workspace: 'ws_1' },
    })
    check('unknown /reset field is 400', badField.status === 400, JSON.stringify(badField.json))
    const badFixture = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'f', fixture: '../trello/v1' },
    })
    check('pathed fixture name is 400', badFixture.status === 400, JSON.stringify(badFixture.json))
    const missing = await call(fake, '/reset', {
      method: 'POST',
      body: { run: 'f', fixture: 'nope' },
    })
    check('unknown fixture name is 400', missing.status === 400, JSON.stringify(missing.json))

    process.stdout.write(`\nselftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
