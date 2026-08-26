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

import { ResetBodyError } from './errors.ts'
import { loadFixture, DEFAULT_FIXTURE } from './fixture.ts'
import { seedFixture } from './seed.ts'
import { checkName, DEFAULT_RUN, DEFAULT_TENANT } from './tenant.ts'
import type { MinimalClient } from './db.ts'
import type { Fake, RunState } from './base.ts'
import type { ClientPool } from './db.ts'
import type { JsonValue, ResetRequest, ResetResponse, SeedReport } from './types.ts'

const KNOWN = new Set(['run', 'epoch', 'tenants', 'fixture', 'extras'])

// One body shape and one response shape, replacing five incompatible ones on
// the same path. Every field but `run` is optional, and an unknown field
// is refused rather than ignored: a host that sends `workspace` where the kit
// wants `tenants` must fail loudly at the door, not silently reset the wrong
// thing and then disagree with the other host.
export function parseResetBody(raw: JsonValue, fallbackTenants: string[]): ResetRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ResetBodyError('reset body must be a JSON object')
  }
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k))
  if (unknown.length > 0) {
    throw new ResetBodyError(`unknown /reset fields: ${unknown.sort().join(', ')}`)
  }
  const run = raw.run === undefined ? DEFAULT_RUN : raw.run
  if (typeof run !== 'string') throw new ResetBodyError('/reset run must be a string')
  const epoch = raw.epoch
  if (epoch !== undefined && typeof epoch !== 'string') {
    throw new ResetBodyError('/reset epoch must be an ISO string')
  }
  const tenantsRaw = raw.tenants
  let tenants: string[]
  if (tenantsRaw === undefined) {
    tenants = fallbackTenants
  } else if (Array.isArray(tenantsRaw) && tenantsRaw.every((s) => typeof s === 'string')) {
    tenants = tenantsRaw
  } else {
    throw new ResetBodyError('/reset tenants must be a list of strings')
  }
  if (tenants.length === 0) throw new ResetBodyError('/reset tenants must not be empty')
  const fixture = raw.fixture === undefined ? DEFAULT_FIXTURE : raw.fixture
  if (typeof fixture !== 'string') throw new ResetBodyError('/reset fixture must be a name')
  const extras = raw.extras
  if (
    extras !== undefined &&
    (typeof extras !== 'object' || extras === null || Array.isArray(extras))
  ) {
    throw new ResetBodyError('/reset extras must be an object')
  }
  const out: ResetRequest = {
    run: checkName('run', run),
    tenants: tenants.map((s) => checkName('tenant', s)),
    fixture,
    extras: extras === undefined ? {} : extras,
  }
  if (epoch !== undefined) out.epoch = epoch
  return out
}

export async function applyReset<C extends MinimalClient>(
  fake: Fake<C>,
  pool: ClientPool<C>,
  state: (run: string) => RunState,
  req: ResetRequest,
): Promise<ResetResponse> {
  const db = await pool.recreate(req.run)
  const st = state(req.run)
  st.clock.setEpoch(req.epoch)
  st.minter.reset()
  const fixture = loadFixture(fake.config.service, req.fixture)
  const seeded: SeedReport[] = []
  for (const tenant of req.tenants) {
    const rows = await seedFixture(db, fixture, {
      dmmf: fake.dmmf,
      tenant,
      tenantKind: fake.config.tenantKind,
      ...(fake.seedRoots === undefined ? {} : { roots: fake.seedRoots }),
    })
    if (fake.afterSeed !== undefined) await fake.afterSeed(db, tenant, rows, req.extras)
    seeded.push({ tenant, rows })
  }
  return {
    ok: true,
    run: req.run,
    epoch: req.epoch ?? null,
    tenants: req.tenants,
    seeded,
  }
}

export function defaultTenantsOf<C extends MinimalClient>(fake: Fake<C>): string[] {
  return fake.defaultTenants ?? [DEFAULT_TENANT]
}
