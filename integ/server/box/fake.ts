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

import { Prisma, PrismaClient } from '../../generated/box/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { boxRoutes } from './routes.ts'

// The fixture is deliberately EMPTY. A Box account starts with nothing but its
// "All Files" root, and that root is not data: an account here exists the
// moment a token is presented, so store.ensureRoot materialises it on the
// first folder lookup. Seeding it per tenant instead would mean an account
// could only be used after a /reset that named it, and on a server shared by
// two hosts that reset drops the other host's data.
//
// The content a target mounts is a DIRECTORY TREE under integ/fixtures/ that
// s3, disk and every other storage target share, uploaded over this fake's own
// endpoints by the adapter.
//
// `items` names BoxItem explicitly: the seeder de-pluralizes a fixture key to
// a model name, and `item` is not what the model is called.
export const boxFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: { items: 'BoxItem' },
  routes: boxRoutes,
}
