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

// Create a repo and give it one README, which is how every card in the tests
// after this point gets there: through the commit endpoint, not a fixture.
async function repoWithCard(
  endpoint: string,
  kind: string,
  name: string,
  card: string,
): Promise<void> {
  const made = await fetch(`${endpoint}/api/repos/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: kind === 'models' ? 'model' : kind.slice(0, -1) }),
  })
  check(`${name} is created`, made.status === 200, String(made.status))
  const pushed = await fetch(`${endpoint}/api/${kind}/${TENANT}/${name}/commit/main`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
    body: [
      JSON.stringify({ key: 'header', value: { summary: 'add a card' } }),
      JSON.stringify({ key: 'file', value: { path: 'README.md', content: card } }),
    ].join('\n'),
  })
  check(`${name} gets its card`, pushed.status === 200, String(pushed.status))
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
    // A MODEL spells its language, library and pipeline bare; only license is
    // prefixed. Probed on google-bert/bert-base-uncased, which carries
    // "transformers", "fill-mask", "en" and "license:apache-2.0".
    eq('a model card becomes model-spelled facets', info.tags ?? null, [
      'conversational',
      'en',
      'license:apache-2.0',
      'summarization',
      'transformers',
    ])
    // A DATASET prefixes its language and its task categories, which is the
    // spelling rajpurkar/squad uses.
    const dsInfo = (await get(fake.endpoint, '/api/datasets/integ/card-data-a')) as Record<
      string,
      JsonValue
    >
    eq('a dataset card becomes dataset-spelled facets', dsInfo.tags ?? null, [
      'language:en',
      'license:mit',
      'size_categories:n<1K',
      'task_categories:summarization',
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
    // The facets a model request actually filters on. These are bare, so a
    // model-only field left out of `tags` makes the query silently empty.
    eq(
      'filter matches a model pipeline tag',
      ids(await get(fake.endpoint, '/api/models?filter=summarization')),
      ['integ/card-model'],
    )
    eq(
      'filter matches a model library',
      ids(await get(fake.endpoint, '/api/models?filter=transformers')),
      ['integ/card-model'],
    )
    eq(
      'a model language filter is bare, not prefixed',
      ids(await get(fake.endpoint, '/api/models?filter=en')),
      ['integ/card-model'],
    )
    eq(
      'a dataset language filter IS prefixed',
      ids(await get(fake.endpoint, '/api/datasets?filter=language:en')),
      ['integ/card-data-a', 'other/card-data-b'],
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
    // Ordered AGAINST likes in the fixture on purpose: while the two were
    // aliased, this assertion and the likes one could not disagree.
    eq(
      'sort=trending_score is not sort=likes',
      ids(await get(fake.endpoint, '/api/datasets?sort=trending_score')).slice(0, 2),
      ['other/card-data-b', 'integ/card-data-a'],
    )
    eq(
      'sort=likes orders the other way round',
      ids(await get(fake.endpoint, '/api/datasets?sort=likes')).slice(0, 2),
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
    eq('expand returns id and trendingScore plus the named properties', expanded, [
      { id: 'integ/card-model', trendingScore: 8, likes: 42, downloads: 5000 },
    ])

    // ---- the trimmed row, and the one parameter that un-trims it
    const bare = (await get(fake.endpoint, '/api/models')) as Record<string, JsonValue>[]
    const first = bare[0] ?? {}
    // The three field sets are the probed ones. A bare row carries no
    // author/sha/lastModified/gated, and NO row carries cardData without the
    // parameter of that name, which is not part of `full`.
    eq('a bare listing row is the probed trimmed field set', Object.keys(first).sort(), [
      'createdAt',
      'downloads',
      'id',
      'library_name',
      'likes',
      'modelId',
      'pipeline_tag',
      'private',
      'tags',
      'trendingScore',
    ])
    const bareData = (await get(fake.endpoint, '/api/datasets')) as Record<string, JsonValue>[]
    eq('a dataset row is wider and carries no modelId', Object.keys(bareData[0] ?? {}).sort(), [
      'author',
      'createdAt',
      'disabled',
      'downloads',
      'gated',
      'id',
      'lastModified',
      'likes',
      'private',
      'sha',
      'tags',
      'trendingScore',
    ])
    const bareSpace = (await get(fake.endpoint, '/api/spaces')) as Record<string, JsonValue>[]
    eq('a space row is the narrowest of the three', Object.keys(bareSpace[0] ?? {}).sort(), [
      'createdAt',
      'id',
      'likes',
      'private',
      'tags',
      'trendingScore',
    ])
    const fullRows = (await get(fake.endpoint, '/api/models?full=1')) as Record<string, JsonValue>[]
    const fullFirst = fullRows[0] ?? {}
    check('full=1 adds siblings', fullFirst.siblings !== undefined, '')
    check(
      'full=1 adds author, sha, gated and lastModified',
      fullFirst.author !== undefined &&
        fullFirst.sha !== undefined &&
        fullFirst.gated !== undefined &&
        fullFirst.lastModified !== undefined,
      '',
    )
    check('full=1 does NOT add cardData', fullFirst.cardData === undefined, '')
    const carded = (await get(fake.endpoint, '/api/models?cardData=1')) as Record<
      string,
      JsonValue
    >[]
    check(
      'cardData=1 adds it to an otherwise trimmed row',
      (carded[0] ?? {}).cardData !== undefined && (carded[0] ?? {}).siblings === undefined,
      '',
    )
    // Upstream's own rule, stated on `list_models`: full "is set to `True` by
    // default when using a filter".
    const filtered = (await get(fake.endpoint, '/api/models?filter=summarization')) as Record<
      string,
      JsonValue
    >[]
    check('a filter defaults to the full row', (filtered[0] ?? {}).siblings !== undefined, '')
    const searched = (await get(fake.endpoint, '/api/models?search=card')) as Record<
      string,
      JsonValue
    >[]
    check('search alone stays trimmed', (searched[0] ?? {}).siblings === undefined, '')

    // A repository cannot have been modified before it existed. The fixture
    // states a repo's createdAt and its initial commit's separately, so the
    // two can drift apart silently now that lastModified comes from the
    // commit; this is the guard that says so.
    for (const kind of ['models', 'datasets', 'spaces']) {
      const rows = (await get(fake.endpoint, `/api/${kind}?full=1`)) as Record<string, JsonValue>[]
      const bad = rows.filter((r) => String(r.lastModified) < String(r.createdAt))
      check(
        `every ${kind} row is modified at or after it was created`,
        bad.length === 0,
        JSON.stringify(bad.map((r) => [r.id, r.createdAt, r.lastModified])),
      )
    }

    // ---- lastModified is the HEAD commit's, not the first blob's
    const before = (await get(fake.endpoint, '/api/datasets/other/card-data-b')) as Record<
      string,
      JsonValue
    >
    // The added path sorts AFTER README.md, so the first blob keeps the old
    // timestamp and only the commit knows the repository moved.
    const pushed = await fetch(`${fake.endpoint}/api/datasets/other/card-data-b/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'add a late-sorting file' } }),
        JSON.stringify({ key: 'file', value: { path: 'zz-late.txt', content: 'later\n' } }),
      ].join('\n'),
    })
    check('a second commit lands', pushed.status === 200, String(pushed.status))
    const after2 = (await get(fake.endpoint, '/api/datasets/other/card-data-b')) as Record<
      string,
      JsonValue
    >
    check(
      'lastModified follows the new commit, not the first blob',
      String(after2.lastModified) > String(before.lastModified),
      `${String(before.lastModified)} -> ${String(after2.lastModified)}`,
    )
    // The info endpoint and the listing derive it the same way, so a fix to
    // one that misses the other fails here.
    const listed = (await get(fake.endpoint, '/api/datasets?author=other&full=1')) as Record<
      string,
      JsonValue
    >[]
    eq(
      'the listing agrees with the info endpoint',
      (listed[0] ?? {}).lastModified ?? null,
      after2.lastModified ?? null,
    )
    eq(
      'sort=last_modified puts the just-committed repo first',
      ids(await get(fake.endpoint, '/api/datasets?sort=last_modified'))[0] ?? '',
      'other/card-data-b',
    )

    // ---- a Space carries one facet its card does not
    // `hf repo create --repo-type space --space_sdk gradio` stores the sdk and
    // writes no README, so a card-only tag list left the new Space
    // unreachable by the facet the Hub spells bare (`gradio/hello_world` ->
    // ["gradio", "region:us"]) while the body reported it as `sdk`.
    const made = await fetch(`${fake.endpoint}/api/repos/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sdk-space', type: 'space', sdk: 'gradio' }),
    })
    check('a space is created with an sdk', made.status === 200, String(made.status))
    const spaceInfo = (await get(fake.endpoint, `/api/spaces/${TENANT}/sdk-space`)) as Record<
      string,
      JsonValue
    >
    eq('the stored sdk is a bare facet', spaceInfo.tags ?? null, ['gradio'])
    eq(
      'the new space is reachable by its sdk facet',
      ids(await get(fake.endpoint, '/api/spaces?filter=gradio')),
      [`${TENANT}/sdk-space`],
    )

    // The card outranks the stored sdk. A Space created as gradio whose card
    // later says docker IS a docker Space; answering ?filter=gradio with it
    // would be reporting history.
    const moved = await fetch(`${fake.endpoint}/api/spaces/${TENANT}/sdk-space/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'switch to docker' } }),
        JSON.stringify({
          key: 'file',
          value: { path: 'README.md', content: '---\nsdk: docker\n---\n\n# Space\n' },
        }),
      ].join('\n'),
    })
    check('the space card lands', moved.status === 200, String(moved.status))
    const moved2 = (await get(fake.endpoint, `/api/spaces/${TENANT}/sdk-space`)) as Record<
      string,
      JsonValue
    >
    eq('the card sdk replaces the stored one in tags', moved2.tags ?? null, ['docker'])
    eq('the rendered sdk agrees with the tag', moved2.sdk ?? null, 'docker')
    eq(
      'the old sdk no longer matches',
      ids(await get(fake.endpoint, '/api/spaces?filter=gradio')),
      [],
    )

    // A card key the parser does not model is dropped WHOLE. Half-collecting
    // it put the string "name: text" into dataset_info, which is worse than
    // losing the key because it renders malformed cardData to a client.
    const nested = await fetch(`${fake.endpoint}/api/repos/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nested-card', type: 'dataset' }),
    })
    check('a dataset for the nested card is created', nested.status === 200, String(nested.status))
    // Modelled on rajpurkar/squad, whose card carries all three constructs
    // this subset refuses AND every dataset facet field. `configs:` is the
    // one that has no indented `key:` line at all: its single item IS the
    // mapping, so only the item-shape rule catches it.
    const nestedCard = [
      '---',
      'license: mit',
      'annotations_creators:',
      '  - crowdsourced',
      'language_creators:',
      '  - crowdsourced',
      '  - found',
      'language:',
      '  - en',
      'multilinguality:',
      '  - monolingual',
      'size_categories:',
      '  - 10K<n<100K',
      'source_datasets:',
      '  - extended|wikipedia',
      'task_categories:',
      '  - question-answering',
      'task_ids:',
      '  - extractive-qa',
      'extra_gated_prompt: |',
      '  You agree not to do bad things.',
      '  Second line.',
      'dataset_info:',
      '  features:',
      '  - name: text',
      '    dtype: string',
      'configs:',
      '  - config_name: default',
      'pretty_name: Nested',
      '---',
      '',
      '# Nested',
      '',
    ].join('\n')
    const pushedCard = await fetch(
      `${fake.endpoint}/api/datasets/${TENANT}/nested-card/commit/main`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
        body: [
          JSON.stringify({ key: 'header', value: { summary: 'add a nested card' } }),
          JSON.stringify({ key: 'file', value: { path: 'README.md', content: nestedCard } }),
        ].join('\n'),
      },
    )
    check('the nested card lands', pushedCard.status === 200, String(pushedCard.status))
    const nestedInfo = (await get(fake.endpoint, `/api/datasets/${TENANT}/nested-card`)) as Record<
      string,
      JsonValue
    >
    const nestedData = (nestedInfo.cardData ?? {}) as Record<string, JsonValue>
    check(
      'a nested mapping key is omitted, not half-collected',
      nestedData.dataset_info === undefined,
      JSON.stringify(nestedData.dataset_info ?? null),
    )
    check(
      'a bare sequence of mappings is omitted too',
      nestedData.configs === undefined,
      JSON.stringify(nestedData.configs ?? null),
    )
    check(
      'a block scalar is omitted rather than stored as "|"',
      nestedData.extra_gated_prompt === undefined,
      JSON.stringify(nestedData.extra_gated_prompt ?? null),
    )
    eq('and the key after all three still parses', nestedData.pretty_name ?? null, 'Nested')
    eq('the keys before them still parse', nestedData.license ?? null, 'mit')
    // The facet list the real squad card produces on the Hub, minus the
    // facets derived from files and hosting (format:, modality:, library:,
    // region:) that a card-only fake cannot know.
    eq('every dataset card facet is spelled', nestedInfo.tags ?? null, [
      'annotations_creators:crowdsourced',
      'language:en',
      'language_creators:crowdsourced',
      'language_creators:found',
      'license:mit',
      'multilinguality:monolingual',
      'size_categories:10K<n<100K',
      'source_datasets:extended|wikipedia',
      'task_categories:question-answering',
      'task_ids:extractive-qa',
    ])

    // ---- a CRLF card is still a card
    // A README uploaded from Windows has CRLF, which is legal YAML. The
    // opening fence did not match it, so the whole card read as absent and
    // cardData, sdk and every facet vanished without an error anywhere.
    await repoWithCard(
      fake.endpoint,
      'models',
      'crlf-model',
      ['---', 'license: mit', '---', '', '# CRLF', ''].join('\r\n'),
    )
    const crlf = (await get(fake.endpoint, `/api/models/${TENANT}/crlf-model`)) as Record<
      string,
      JsonValue
    >
    eq(
      'a CRLF card parses',
      ((crlf.cardData ?? {}) as Record<string, JsonValue>).license ?? null,
      'mit',
    )
    eq('a CRLF card yields its facets', crlf.tags ?? null, ['license:mit'])

    // ---- base_model is card-derived, so it is a facet
    // The Hub also emits a relationship form (`base_model:finetune:X`,
    // `base_model:quantized:X`). That one is its own analysis of the model,
    // not a card field, so it belongs with arxiv:/region:/format: among the
    // facets a card-only fake cannot know.
    await repoWithCard(
      fake.endpoint,
      'models',
      'derived-model',
      [
        '---',
        'license: apache-2.0',
        'library_name: transformers',
        'pipeline_tag: text-generation',
        'base_model:',
        '  - acme/base',
        '---',
        '',
        '# Derived',
        '',
      ].join('\n'),
    )
    const derived = (await get(fake.endpoint, `/api/models/${TENANT}/derived-model`)) as Record<
      string,
      JsonValue
    >
    eq('base_model is spelled as the Hub spells it', derived.tags ?? null, [
      'base_model:acme/base',
      'license:apache-2.0',
      'text-generation',
      'transformers',
    ])
    eq(
      'a model is reachable by its base_model facet',
      ids(await get(fake.endpoint, '/api/models?filter=base_model:acme/base')),
      [`${TENANT}/derived-model`],
    )

    // ---- an inline comment is a comment, and a bare # is not
    // `license: mit # SPDX` kept its tail, so the facet read
    // `license:mit # SPDX` and an ordinary ?filter=license:mit missed it.
    // The two literal cases have to survive: YAML starts a comment only at a
    // `#` preceded by whitespace, and never inside quotes.
    await repoWithCard(
      fake.endpoint,
      'models',
      'commented',
      [
        '---',
        'license: bsd-3-clause # SPDX identifier',
        'library_name: transformers # the library',
        'pipeline_tag: text-generation',
        'tags:',
        '  - some#tag',
        '  - conversational # a real comment',
        '---',
        '',
        '# Commented',
        '',
      ].join('\n'),
    )
    const commented = (await get(fake.endpoint, `/api/models/${TENANT}/commented`)) as Record<
      string,
      JsonValue
    >
    eq('an inline comment is stripped, a bare # is kept', commented.tags ?? null, [
      'conversational',
      'license:bsd-3-clause',
      'some#tag',
      'text-generation',
      'transformers',
    ])
    eq(
      'the commented card is reachable by the plain facet',
      ids(await get(fake.endpoint, '/api/models?filter=license:bsd-3-clause')),
      [`${TENANT}/commented`],
    )

    // ---- a tree page's Link header carries the run it was reached through
    // The request flow strips `/_run/<id>` before a handler sees the path, so
    // a Link header built from ctx.url alone pointed page two at the DEFAULT
    // run. Only the path channel can express this, which is the point of it:
    // a mount hands its base URL to a vendor SDK and never sees the request
    // again, so a header or a query parameter cannot survive the handoff.
    const RUN = 'hf-hub-page'
    const scoped = `${fake.endpoint}/_run/${RUN}`
    const mkRepo = await fetch(`${scoped}/api/repos/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'paged', type: 'model' }),
    })
    check('a repo is created inside the run', mkRepo.status === 200, String(mkRepo.status))
    const three = await fetch(`${scoped}/api/models/${TENANT}/paged/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'three files' } }),
        JSON.stringify({ key: 'file', value: { path: 'a.txt', content: 'a' } }),
        JSON.stringify({ key: 'file', value: { path: 'b.txt', content: 'b' } }),
        JSON.stringify({ key: 'file', value: { path: 'c.txt', content: 'c' } }),
      ].join('\n'),
    })
    check('the run gets three files', three.status === 200, String(three.status))
    const pageOne = await fetch(`${scoped}/api/models/${TENANT}/paged/tree/main?limit=2`, {
      headers: { Authorization: `Bearer ${TENANT}` },
    })
    const link = pageOne.headers.get('link') ?? ''
    check(
      'the next-page Link carries the run prefix',
      link.includes(`/_run/${RUN}/api/models/`),
      link,
    )
    // Followed rather than only inspected: the prefix is only worth anything
    // if the URL it produces answers from the same world.
    const next = await fetch(link.slice(1, link.indexOf('>')), {
      headers: { Authorization: `Bearer ${TENANT}` },
    })
    check('page two is 200', next.status === 200, String(next.status))
    eq(
      'page two holds this run rows, not the default run',
      ((await next.json()) as JsonValue[]).map((r) =>
        String((r as Record<string, JsonValue>).path ?? ''),
      ),
      ['c.txt'],
    )

    const unauth = await fetch(`${fake.endpoint}/api/models`)
    check('an unauthenticated listing is refused', unauth.status === 401, String(unauth.status))

    process.stdout.write(`hf_hub selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
