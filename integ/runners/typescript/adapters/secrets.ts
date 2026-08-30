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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from '@struktoai/mirage-core/resource/secrets'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import type { EnvEntries, ResolvedSecret } from '@struktoai/mirage-core/secrets/types'

const CounterConfig = z.strictObject({})
type CounterConfig = z.infer<typeof CounterConfig>

const DeadConfig = z.strictObject({})
type DeadConfig = z.infer<typeof DeadConfig>

async function fetchDead(_config: DeadConfig, _ref: string): Promise<ResolvedSecret> {
  throw new SecretsError('vault sealed')
}

/**
 * The env plane a secrets target declares, plus its cleanup.
 *
 * Registers the counting fake (fresh per-ref counters per open, so the
 * counts inside fetched values are deterministic within one target run
 * and prove how many times each secret was fetched), materializes the
 * dotenv file the `dotenv` entry points at (its path exists only at run
 * time, which is why the block is built here and not spelled in
 * targets.json), and seeds the process variable the `env` entry reads.
 * `kind` "dead" is a separate target on purpose: a whole-env command
 * fetches every unfetched name, so one dead source would fail the
 * healthy target's `env` case.
 */
export function buildSecretsEnv(kind: string): {
  env: EnvEntries
  cleanup: () => Promise<void>
} {
  if (kind === 'dead') {
    registerSecrets('dead', DeadConfig, fetchDead)
    return { env: { DEAD: { from: 'dead', ref: 'x' } }, cleanup: async () => undefined }
  }
  const counts = new Map<string, number>()
  const fetchCounting = async (_config: CounterConfig, ref: string): Promise<ResolvedSecret> => {
    const n = (counts.get(ref) ?? 0) + 1
    counts.set(ref, n)
    return {
      fields: {
        token: `tok${String(n)}`,
        user: `u${String(n)}`,
        pass: `p${String(n)}`,
      },
    }
  }
  registerSecrets('counter', CounterConfig, fetchCounting)
  process.env.MIRAGE_INTEG_ENV_SECRET = 'from-process-env'
  const dir = mkdtempSync(join(tmpdir(), 'mirage-integ-secrets-'))
  const dotfile = join(dir, 'secrets.env')
  writeFileSync(dotfile, 'DOTFILE_SECRET=from-dotenv\n')
  const cleanup = async (): Promise<void> => {
    rmSync(dir, { recursive: true, force: true })
  }
  const env: EnvEntries = {
    APP_NAME: 'integ',
    EDITOR: { value: 'vi', readonly: true },
    TOKEN: { from: 'counter', ref: 'tok', key: 'token' },
    DB_USER: { from: 'counter', ref: 'db', key: 'user' },
    DB_PASS: { from: 'counter', ref: 'db', key: 'pass' },
    EAGER_PAIR: { from: 'counter', ref: 'pair', key: 'token', fetch: 'eager' },
    LAZY_PAIR: { from: 'counter', ref: 'pair', key: 'user' },
    FROM_ENV: { from: 'env', key: 'MIRAGE_INTEG_ENV_SECRET' },
    FROM_DOTFILE: { from: 'dotenv', ref: dotfile, key: 'DOTFILE_SECRET' },
    FN_TOKEN: { from: 'counter', ref: 'fn', key: 'token' },
    IND_TOKEN: { from: 'counter', ref: 'ind', key: 'token' },
  }
  return { env, cleanup }
}
