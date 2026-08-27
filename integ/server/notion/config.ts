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
import type { PrismaClient } from '../../generated/notion/index.js'

export type C = PrismaClient

export const config = parseConfig({
  service: 'notion',
  schema: schemaFor('notion'),
  defaultPort: 5091,
  tenantKind: 'pk-column',
  // The token IS the workspace, with no prefix to strip: Notion hands an
  // integration one opaque secret and every call carries it. That is why the
  // workspace NAME had to stop being the token (it is seeded on NotionMeta
  // now) -- the two were one string, so making the token per-run would have
  // changed what `ntn whoami` prints, which three goldens and the conformance
  // run against the real binary all pin.
  tenantFromBearer: true,
  // One counter per workspace across every kind, which is what the fake this
  // replaces did: `mintId` read a single per-workspace seq whatever the prefix
  // was, so creating a page advanced the number a later block would get.
  mintSharing: 'global',
})

export const DEFAULT_API_VERSION = '2025-09-03'
// The generation that split a database into a container plus data sources.
// Equal to DEFAULT_API_VERSION today and kept as its own name because the
// comparison in `databaseJson` is about the SPLIT, not about the default.
export const DATA_SOURCE_VERSION = '2025-09-03'
export const MAX_PAGE_SIZE = 100
