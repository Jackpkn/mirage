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
import type { PrismaClient } from '../../generated/hf/index.js'

export type C = PrismaClient

// tenantFromBearer: the client sends the user's Hugging Face token verbatim on
// every Hub call, so the account is already on the wire and each run can take
// its own.
//
// maxBodyBytes is four times the kit's default because a xorb is a CAS block,
// not a file: the client packs many chunks into one and uploads it whole, so
// the request body is bounded by Xet's block size rather than by anything the
// battery writes.
export const config = parseConfig({
  service: 'hf',
  schema: schemaFor('hf'),
  defaultPort: 5099,
  tenantKind: 'pk-column',
  tenantFromBearer: true,
  mintFormat: '{n}',
  maxBodyBytes: 256 * 1024 * 1024,
})

// The account every CAS row is filed under, which is no account at all.
//
// Content addressed by hash is GLOBAL on the real Hub -- that is what its
// dedup endpoint is for -- and the client knows it: it keeps a local shard
// cache and, for content it has uploaded before, sends the commit WITHOUT
// re-uploading the blocks. Filing blocks per account made that assumption
// false, and the failure is not hypothetical: both hosts run against one
// server on one machine and share one client cache, so whichever host wrote a
// fixture first left the second one committing a file whose bytes the fake had
// filed under someone else. Names stay per account; bytes do not.
//
// It is still a `tenant` value rather than a missing column, because a model
// with no tenant cannot be cleared by a scoped /reset at all (see the kit's
// `untenanted`). A constant that no run ever names is exactly right: a reset
// drops one run's names and leaves the CAS, which is what the real one does.
export const CAS_TENANT = 'cas'
