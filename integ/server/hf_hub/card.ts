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

import type { JsonValue } from '../kit/typescript/types.ts'

const FENCE = '---'

// A deliberate subset of YAML, not a parser: scalars, block lists and flow
// lists, which is what a Hub card's frontmatter actually contains
// (`license`, `tags`, `task_categories`, `language`, `pipeline_tag`,
// `library_name`). integ has no YAML dependency and a card is not the place
// to acquire one; anything richer than this belongs in a fixture that states
// the field directly. A nested mapping is skipped rather than guessed at, so
// an unsupported card loses one key instead of parsing to something wrong.
// A YAML comment starts at a `#` that is outside quotes AND preceded by
// whitespace or nothing. Both halves matter: `license: mit # SPDX` has to
// lose its tail, while `- some#tag` and `- "a # b"` are literal values.
function stripComment(raw: string): string {
  let quote = ''
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1] ?? ''))) return raw.slice(0, i)
  }
  return raw
}

function scalar(raw: string): JsonValue {
  const v = stripComment(raw)
    .trim()
    .replace(/^["']|["']$/g, '')
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && /^-?\d+$/.test(v)) return Number(v)
  return v
}

/**
 * The YAML frontmatter of a Hub card, as `cardData`.
 *
 * A card IS `README.md`: the Hub derives `cardData` from the block fenced by
 * `---` at the top of it, which is why this reads the blob rather than a
 * column. Storing the same fields twice would let a card and its metadata
 * disagree, and the card is the copy a human edits.
 *
 * Returns an empty object for a README with no frontmatter, which is a
 * legal card, and for one whose fence never closes.
 */
export function parseCard(raw: string): Record<string, JsonValue> {
  // CRLF is a legal YAML line ending and a README uploaded from Windows has
  // it, so the fences and every line are normalized before anything is
  // scanned. Without this the opening fence did not match and the whole card
  // read as absent: no cardData, no sdk, no facets, silently.
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith(`${FENCE}\n`)) return {}
  const end = text.indexOf(`\n${FENCE}`, FENCE.length)
  if (end === -1) return {}
  const out: Record<string, JsonValue> = {}
  let key = ''
  let list: JsonValue[] | null = null
  for (const line of text.slice(FENCE.length + 1, end).split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // An INDENTED mapping line means this key is richer than the subset
    // above, so the key is dropped whole rather than half-collected. Without
    // this, `dataset_info:` followed by `  features:` and `  - name: text`
    // kept the top-level list open and appended the string "name: text" to
    // it, which is worse than losing the key: it renders malformed cardData.
    if (/^\s+[A-Za-z_][\w-]*:/.test(line)) {
      if (key !== '') delete out[key]
      key = ''
      list = null
      continue
    }
    // A list of MAPPINGS is the other shape a nested structure takes, and it
    // can carry no indented `key:` line at all: `configs:` followed by
    // `- config_name: default` is one item with one key, so the rule above
    // never fires and the item was collected as the string
    // "config_name: default". The colon has to be followed by a space or the
    // end of the line, which is what YAML requires of a key and what keeps a
    // facet-shaped value such as `arxiv:1606.05250` a scalar.
    if (/^\s*-\s+[A-Za-z_][\w-]*:(\s|$)/.test(line)) {
      if (key !== '') delete out[key]
      key = ''
      list = null
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && list !== null) {
      list.push(scalar(item[1] ?? ''))
      continue
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (pair === null) continue
    if (list !== null && key !== '') out[key] = list
    key = pair[1] ?? ''
    const rest = stripComment(pair[2] ?? '').trim()
    if (rest === '') {
      list = []
      continue
    }
    list = null
    // A block scalar (`|`, `>`) keeps its value on the lines that follow, and
    // a flow mapping holds a shape this subset cannot. Both were stored as
    // the literal text after the colon, so `extra_gated_prompt: |` rendered
    // as the string "|".
    if (rest.startsWith('|') || rest.startsWith('>') || rest.startsWith('{')) {
      key = ''
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      out[key] = inner === '' ? [] : inner.split(',').map((p) => scalar(p))
      continue
    }
    out[key] = scalar(rest)
  }
  if (list !== null && key !== '') out[key] = list
  return out
}

// Probed against the live Hub rather than guessed at, because the three kinds
// genuinely disagree about how a card field is spelled as a facet:
//
//   models   google-bert/bert-base-uncased
//              transformers, fill-mask, en, dataset:bookcorpus,
//              license:apache-2.0
//   datasets rajpurkar/squad
//              task_categories:question-answering, language:en,
//              license:cc-by-sa-4.0, size_categories:10K<n<100K
//   spaces   gradio/hello_world
//              gradio, region:us
//
// So a model spells its language, library and pipeline BARE where a dataset
// prefixes its language, and a model's `datasets:` card field becomes the
// SINGULAR `dataset:`. Only `license:` and the card's own `tags` are shared.
const MODEL_FACETS = [
  ['license', 'license:'],
  ['library_name', ''],
  ['pipeline_tag', ''],
  ['language', ''],
  ['datasets', 'dataset:'],
  ['base_model', 'base_model:'],
] as const

// Every one of these was read off rajpurkar/squad, whose card carries all of
// them and whose Hub tags spell each as `<field>:<value>`. A field missing
// from this table is not a cosmetic gap: `?filter=task_ids:extractive-qa`
// answers with nothing, silently, because the filter reads only this list.
const DATASET_FACETS = [
  ['license', 'license:'],
  ['task_categories', 'task_categories:'],
  ['task_ids', 'task_ids:'],
  ['language', 'language:'],
  ['language_creators', 'language_creators:'],
  ['annotations_creators', 'annotations_creators:'],
  ['multilinguality', 'multilinguality:'],
  ['source_datasets', 'source_datasets:'],
  ['size_categories', 'size_categories:'],
] as const

const SPACE_FACETS = [
  ['license', 'license:'],
  ['sdk', ''],
] as const

function facetsFor(kind: string): readonly (readonly [string, string])[] {
  if (kind === 'models') return MODEL_FACETS
  if (kind === 'spaces') return SPACE_FACETS
  return DATASET_FACETS
}

/**
 * The Hub tag list a card implies, in that kind's spelling.
 *
 * The Hub's `tags` are facets, not git tags. Git tags are reachable at
 * `/refs` and do not belong here; conflating the two made
 * `hf repo tag create v1` show up as a facet on the model object.
 *
 * A real repo also carries framework, format and region facets (`pytorch`,
 * `format:parquet`, `region:us`). Those are derived from its files and its
 * hosting rather than from its card, so a fake reading only the card cannot
 * produce them and does not pretend to.
 */
export function cardTags(card: Record<string, JsonValue>, kind: string): string[] {
  const out: string[] = []
  const push = (prefix: string, v: JsonValue): void => {
    if (typeof v === 'string' && v !== '') out.push(`${prefix}${v}`)
  }
  for (const [field, prefix] of facetsFor(kind)) {
    const v = card[field]
    if (Array.isArray(v)) for (const one of v) push(prefix, one)
    else if (v !== undefined) push(prefix, v)
  }
  const bare = card.tags
  if (Array.isArray(bare)) for (const t of bare) push('', t)
  else if (typeof bare === 'string') push('', bare)
  return [...new Set(out)].sort()
}
