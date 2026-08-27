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

import { Prisma, PrismaClient } from '../../generated/dropbox/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { dropboxRoutes } from './routes.ts'

// The fixture is deliberately EMPTY, and it exists anyway. A Dropbox account
// starts with nothing in it, and the content a target mounts is a DIRECTORY
// TREE under integ/fixtures/ (files/v1, search/v1, wc/v1) that s3, disk and
// every other storage target share, uploaded over this fake's own API by the
// adapter. Restating that tree as JSON here would fork it. What /reset gives
// this fake is the empty account and a fresh clock, which is exactly what it
// needs and all it needs.
//
// `items` names DropboxItem explicitly: the seeder de-pluralizes a fixture key
// to a model name, and `item` is not what the model is called.
export const dropboxFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: { items: 'DropboxItem' },
  routes: dropboxRoutes,
}
