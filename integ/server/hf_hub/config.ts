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

import { parseConfig, schemaFor } from '../kit/typescript/index.ts'
import type { PrismaClient } from '../../generated/hf_hub/index.js'

export type C = PrismaClient

// tenantFromBearer: the Hub authenticates with a user access token sent
// verbatim on every call, so the account is already on the wire and each run
// can take its own without a mirage-only header.
export const config = parseConfig({
  service: 'hf-hub',
  schema: schemaFor('hf_hub'),
  defaultPort: 5090,
  tenantKind: 'pk-column',
  tenantFromBearer: true,
  // Commit shas. One counter serves the whole account, so a commit in one
  // repository advances the number the next one gets, which is fine: a sha is
  // opaque and only has to be unique and stable.
  mintFormat: '{n}',
})

export const DEFAULT_REVISION = 'main'

// A bare tree page returns up to this many rows; `expand=true` caps at 100 and
// the Hub refuses anything larger, which is the asymmetry the client's adaptive
// walk is built around. Both are the real service's numbers.
export const MAX_LIMIT = 1000
export const MAX_LIMIT_EXPANDED = 100
export const DEFAULT_LIMIT = 50

// The three kinds, spelled the way the api path spells them.
export const KINDS = ['models', 'datasets', 'spaces']

// A model sits at the origin root and the other two under a plural segment,
// which is the split `resolve` and the web url both walk.
export const RESOLVE_SEGMENT: Record<string, string> = {
  models: '',
  datasets: 'datasets',
  spaces: 'spaces',
}
