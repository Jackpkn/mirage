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
import type { PrismaClient } from '../../generated/http/index.js'

export type C = PrismaClient

export const config = parseConfig({
  service: 'http',
  schema: schemaFor('http'),
  defaultPort: 5087,
  tenantKind: 'pk-column',
})

// What aiohttp's web.Response(text=...) sent, and therefore what every golden
// recorded against a handler that returned text rather than bytes.
export const TEXT = 'text/plain; charset=utf-8'
