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

import { Prisma, PrismaClient } from '../../generated/hf_hub/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { hfHubRoutes } from './routes.ts'

// The fixture states repositories, their commits and their refs; the FILE
// CONTENT a target mounts is the shared directory tree under integ/fixtures/,
// pushed over this fake's own commit endpoint by the adapter. That is
// deliberate: it makes seeding exercise the write path the battery also
// tests, so a broken commit shows up as an empty mount rather than as a
// green run over data the fake inserted behind its own API.
//
// Each key names its model explicitly because the seeder de-pluralizes a
// fixture key to a model name, and none of these four are named that way.
export const hfHubFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: {
    repos: 'HfRepo',
    commits: 'HfCommit',
    refs: 'HfRef',
    blobs: 'HfBlob',
  },
  routes: hfHubRoutes,
}
