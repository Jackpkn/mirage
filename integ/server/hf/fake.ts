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

import { Prisma, PrismaClient } from '../../generated/hf/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { hfRoutes } from './routes.ts'

// The fixture is deliberately EMPTY. A Hugging Face bucket is not a thing you
// create: it springs into existence for a namespace the token owns the moment
// something is written to it, so there is no row that has to exist before the
// first write.
//
// The content a target mounts is a DIRECTORY TREE under integ/fixtures/ that
// s3, disk and every other storage target share. hf mounts are writable, so the
// harness seeds them through the mount itself rather than over this endpoint.
//
// `objects`, `xorbs` and `xetFiles` are named explicitly: the seeder
// de-pluralizes a fixture key to a model name, which reaches none of the three.
export const hfFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: { objects: 'HfObject', xorbs: 'HfXorb', xetFiles: 'HfXetFile' },
  routes: hfRoutes,
}
