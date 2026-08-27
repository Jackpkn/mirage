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

import type { PrismaClient } from '../../generated/linear/index.js'
import { parseConfig } from '../kit/typescript/config.ts'
import { schemaFor } from '../kit/typescript/fixture.ts'

export type C = PrismaClient

// linear_server.py line 38. Every issue and comment a mutation writes renders
// this exact string as createdAt and updatedAt, and it never advances: the
// old fake had no clock at all, only this literal, and the goldens are cut
// against it. It is deliberately NOT ctx.clock, whose whole point is to move
// one second per touch; a fake that ticked here would renumber a timestamp
// that several recorded outputs spell out.
export const WRITE_STAMP = '2026-06-19T00:00:00.000Z'

export const ISSUE_URL_BASE = 'https://linear.app/strukto/issue'

// The single shared counter is linear's own behaviour: creating a comment
// advances the number the next issue gets (iss_new_1, cmt_new_2, iss_new_3),
// which is what 'global' means here.
export const config = parseConfig({
  service: 'linear',
  schema: schemaFor('linear'),
  tenantKind: 'pk-column',
  mintSharing: 'global',
  mintFormat: '{kind}_new_{n}',
})
