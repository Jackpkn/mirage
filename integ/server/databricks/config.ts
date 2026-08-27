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
import type { PrismaClient } from '../../generated/databricks/index.js'

export type C = PrismaClient

export const config = parseConfig({
  service: 'databricks',
  schema: schemaFor('databricks'),
  defaultPort: 5092,
  // The volume is partitioned by the access token, which both hosts already
  // send as an ordinary `Authorization: Bearer`, so no mirage-only header
  // reaches the resource under test. Each run takes its own token and
  // therefore its own tenant, which is what lets one server answer both hosts.
  tenantKind: 'pk-column',
  tenantFromBearer: true,
})

// Files whose file_size a directory listing omits, though HEAD still reports
// it. This exercises the reader-side size backfill the same way a real listing
// gap would, and it is a rendering rule rather than state, so it stays a
// constant instead of becoming a column no fixture would ever vary.
export const SIZELESS_IN_LISTINGS = new Set(['poem.txt'])
