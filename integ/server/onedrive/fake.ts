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

import { Prisma, PrismaClient } from '../../generated/onedrive/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { onedriveRoutes } from './routes.ts'

// The fixture is deliberately EMPTY. An account here exists the moment a token
// is presented, so seeding per tenant would mean an account could only be used
// after a /reset that named it -- and on a server shared by both hosts that
// reset recreates the whole run file, dropping the other host's data.
//
// Neither kind of drive needs seeding as a result. The default drive is the
// one `/me/drive` resolves to and is implicit in `hasDrive`, because it has to
// answer before anything at all has been declared. A named SharePoint drive is
// deployment state and arrives over `PUT /drives/:key`, the one non-vendor
// route here, which replaces the in-process `add_drive` the adapter used to
// call when the server lived inside it.
//
// The content a target mounts is a DIRECTORY TREE under integ/fixtures/ that
// s3, disk and every other storage target share, written in over Graph's own
// endpoints by the harness tee-seeding.
export const onedriveFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: { drives: 'GraphDrive' },
  routes: onedriveRoutes,
}
