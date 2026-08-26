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
import type { PrismaClient } from '../../generated/trello/index.js'

export type C = PrismaClient

// mintSharing and mintFormat are the kit defaults on purpose: this fake drew
// card and comment ids from ONE counter (crd_new_1 then cmt_new_2), so a
// create-then-comment sequence numbers the same way on both hosts.
export const config = parseConfig({
  service: 'trello',
  schema: schemaFor('trello'),
  defaultPort: 5095,
  tenantKind: 'pk-column',
})

// Writes stamp a fixed dateLastActivity rather than reading the run clock:
// the two hosts assert the rendered value, so it must not move with the
// number of touches a scenario happens to make.
export const WRITE_STAMP = '2026-06-19T00:00:00.000Z'
