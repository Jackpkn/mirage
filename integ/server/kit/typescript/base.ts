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

import { Clock } from './clock.ts'
import { Minter } from './mint.ts'
import { ClientPool } from './db.ts'
import type { ClientCtor, MinimalClient } from './db.ts'
import type { KitConfig } from './config.ts'
import type { Dmmf } from './seed.ts'
import type { KitRoute } from './route.ts'
import type { JsonValue, ResetResponse } from './types.ts'

// What a service implements. Everything else in the kit is machinery around
// these five members: there is no base class to extend and no lifecycle to
// override, because a fake that can only declare things cannot drift from the
// others in how it resets, tenants, seeds or serializes.
export interface Fake<C extends MinimalClient> {
  config: KitConfig
  client: ClientCtor<C>
  dmmf: Dmmf
  routes: () => KitRoute<C>[]
  // Fixture-shape hooks, both optional. `seedRoots` maps a top-level fixture
  // key to a model name for the cases the plural derivation cannot reach.
  // `afterSeed` runs once per seeded tenant, for state a fixture cannot state
  // (a mint counter primed past the fixture's own ids, say).
  seedRoots?: Record<string, string>
  afterSeed?: (
    db: C,
    tenant: string,
    counts: Record<string, number>,
    extras: Record<string, JsonValue>,
  ) => Promise<void>
  defaultTenants?: string[]
}

// Per-run mutable state. A run is a whole isolated world, so its
// clock and its minter are its own: two runs served by one process must
// not advance each other's ids.
export interface RunState {
  clock: Clock
  minter: Minter
}

export interface Runtime<C extends MinimalClient> {
  fake: Fake<C>
  pool: ClientPool<C>
  state: (run: string) => RunState
  reset: (body: JsonValue) => Promise<ResetResponse>
  dispose: () => Promise<void>
}

export function makeState<C extends MinimalClient>(fake: Fake<C>): RunState {
  return {
    clock: new Clock(),
    minter: new Minter(fake.config.mintSharing, fake.config.mintFormat),
  }
}

export function makePool<C extends MinimalClient>(fake: Fake<C>): ClientPool<C> {
  return new ClientPool<C>({
    service: fake.config.service,
    schema: fake.config.schema,
    ctor: fake.client,
  })
}
