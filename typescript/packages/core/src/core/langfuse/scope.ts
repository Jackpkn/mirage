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

import { FileType } from '../../types.ts'
import { INT_JSON, JSON_NAME, JSONL_NAME } from '../hierarchy/codec.ts'
import { Capture, Route } from '../hierarchy/route.ts'
import { makeDetectScope } from '../hierarchy/scope.ts'

export const TOP_LEVEL_DIRS = ['traces', 'sessions', 'prompts', 'datasets']

// One description of the tree: readdir, stat, read AND the grep/rg search
// push-down all classify through it, so the file surface and the search
// surface cannot disagree about what a path means (they used to be two
// hand-maintained dispatch ladders).
export const ROUTES: readonly Route[] = [
  new Route({ kind: 'traces', segments: ['traces'], probed: false }),
  new Route({
    kind: 'trace',
    segments: ['traces', new Capture('trace_id', JSON_NAME)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Route({ kind: 'sessions', segments: ['sessions'], probed: false }),
  new Route({ kind: 'session', segments: ['sessions', new Capture('session_id')] }),
  new Route({
    kind: 'session_trace',
    segments: ['sessions', new Capture('session_id'), new Capture('trace_id', JSON_NAME)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Route({ kind: 'prompts', segments: ['prompts'], probed: false }),
  new Route({ kind: 'prompt', segments: ['prompts', new Capture('prompt_name')] }),
  // A version that is not a plain ASCII integer cannot name a prompt version,
  // so it fails the route match and reads as ENOENT instead of an int() crash
  // (python) or a digit-prefix guess (typescript).
  new Route({
    kind: 'prompt_version',
    segments: ['prompts', new Capture('prompt_name'), new Capture('version', INT_JSON)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Route({ kind: 'datasets', segments: ['datasets'], probed: false }),
  new Route({ kind: 'dataset', segments: ['datasets', new Capture('dataset_name')] }),
  new Route({
    kind: 'dataset_items',
    segments: ['datasets', new Capture('dataset_name'), 'items.jsonl'],
    leaf: true,
    filetype: FileType.TEXT,
  }),
  new Route({ kind: 'runs', segments: ['datasets', new Capture('dataset_name'), 'runs'] }),
  new Route({
    kind: 'dataset_run',
    segments: [
      'datasets',
      new Capture('dataset_name'),
      'runs',
      new Capture('run_name', JSONL_NAME),
    ],
    leaf: true,
    filetype: FileType.TEXT,
  }),
]

export const detectScope = makeDetectScope(ROUTES)

// The kinds the grep/rg push-down may answer with a whole-container search;
// leaves and unrecognized paths fall through to the generic per-file scan.
export const SEARCH_KINDS: Readonly<Record<string, string>> = {
  root: 'traces',
  traces: 'traces',
  sessions: 'sessions',
  session: 'sessions',
  prompts: 'prompts',
  prompt: 'prompts',
  datasets: 'datasets',
  dataset: 'datasets',
}
