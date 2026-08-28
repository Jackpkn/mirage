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
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'

// The battery cannot reach any of this, the same way it cannot reach the kit's
// run and tenant isolation. Listing and search are HTTP surface with no client
// inside mirage: the `hf` CLI has no `models ls` verb and a mount never calls
// /api/models, so a corpus case has no line that would send the request. Left
// to the battery alone, the whole endpoint would ship untested.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-hf-hub'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`hf_hub selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
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
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

async function get(endpoint: string, path: string): Promise<JsonValue> {
  const r = await fetch(`${endpoint}${path}`, { headers: { Authorization: `Bearer ${TENANT}` } })
  check(`GET ${path} is 200`, r.status === 200, String(r.status))
  return (await r.json()) as JsonValue
}

function ids(rows: JsonValue): string[] {
  return Array.isArray(rows)
    ? rows.map((r) => String((r as Record<string, JsonValue>).id ?? ''))
    : []
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    const reset = await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('/reset seeds the fixture', reset.status === 200, String(reset.status))

    // ---- card metadata is derived from README.md, not stored twice
    const info = (await get(fake.endpoint, '/api/models/integ/card-model')) as Record<
      string,
      JsonValue
    >
    eq('author is the namespace', info.author ?? null, 'integ')
    eq('downloads come from the row', info.downloads ?? null, 5000)
    eq('likes come from the row', info.likes ?? null, 42)
    eq('gated "" renders as false', info.gated ?? null, false)
    const card = (info.cardData ?? {}) as Record<string, JsonValue>
    eq('cardData carries the license', card.license ?? null, 'apache-2.0')
    eq('pipeline_tag is lifted from the card', info.pipeline_tag ?? null, 'summarization')
    eq('library_name is lifted from the card', info.library_name ?? null, 'transformers')
    eq('tags are Hub facets, not git tags', info.tags ?? null, [
      'conversational',
      'language:en',
      'license:apache-2.0',
    ])

    // A git tag must NOT appear in `tags`. The two were conflated, so
    // `hf repo tag create` surfaced as a facet on the model object.
    const tagged = await fetch(`${fake.endpoint}/api/models/integ/card-model/tag/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'v9' }),
    })
    check('a git tag is created', tagged.status === 200, String(tagged.status))
    const after = (await get(fake.endpoint, '/api/models/integ/card-model')) as Record<
      string,
      JsonValue
    >
    check(
      'a git tag stays out of the facet list',
      !JSON.stringify(after.tags ?? []).includes('v9'),
      JSON.stringify(after.tags ?? []),
    )
    const refs = (await get(fake.endpoint, '/api/models/integ/card-model/refs')) as Record<
      string,
      JsonValue
    >
    check(
      'the git tag is reachable at /refs',
      JSON.stringify(refs.tags ?? []).includes('v9'),
      JSON.stringify(refs.tags ?? []),
    )

    // ---- listing and search
    eq(
      'search matches a substring of the id',
      ids(await get(fake.endpoint, '/api/datasets?search=card')),
      ['integ/card-data-a', 'other/card-data-b'],
    )
    eq(
      'search is case insensitive',
      ids(await get(fake.endpoint, '/api/datasets?search=CARD-DATA-B')),
      ['other/card-data-b'],
    )
    eq(
      'search that matches nothing is an empty list',
      ids(await get(fake.endpoint, '/api/models?search=zzz')),
      [],
    )
    eq(
      'author narrows to one namespace',
      ids(await get(fake.endpoint, '/api/datasets?author=other')),
      ['other/card-data-b'],
    )
    eq(
      'filter matches a card facet',
      ids(await get(fake.endpoint, '/api/datasets?filter=license:mit')),
      ['integ/card-data-a'],
    )
    eq(
      'two filters narrow rather than widen',
      ids(await get(fake.endpoint, '/api/datasets?filter=license:mit&filter=language:fr')),
      [],
    )
    eq(
      'sort defaults to descending',
      ids(await get(fake.endpoint, '/api/datasets?sort=downloads')).slice(0, 2),
      ['integ/card-data-a', 'other/card-data-b'],
    )
    eq(
      'direction=1 ascends',
      ids(await get(fake.endpoint, '/api/datasets?sort=downloads&direction=1')).slice(-1),
      ['integ/card-data-a'],
    )
    eq('limit truncates', ids(await get(fake.endpoint, '/api/datasets?sort=likes&limit=1')), [
      'integ/card-data-a',
    ])
    // An unknown sort key is ignored rather than guessed at, which is what the
    // Hub does; the five legal keys are upstream's ModelSort_T verbatim.
    eq(
      'an unknown sort key is ignored',
      ids(await get(fake.endpoint, '/api/datasets?sort=nonsense')).length,
      3,
    )

    const expanded = (await get(
      fake.endpoint,
      '/api/models?search=card&expand=likes&expand=downloads',
    )) as JsonValue
    eq('expand returns id plus the named properties only', expanded, [
      { id: 'integ/card-model', likes: 42, downloads: 5000 },
    ])

    const unauth = await fetch(`${fake.endpoint}/api/models`)
    check('an unauthenticated listing is refused', unauth.status === 401, String(unauth.status))

    process.stdout.write(`hf_hub selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
