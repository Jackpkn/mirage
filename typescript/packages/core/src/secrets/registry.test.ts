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

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { SecretsError } from './errors.ts'
import { fetchSecret, knownSources, registerSecrets, sourceFor } from './registry.ts'
import type { ResolvedSecret } from './types.ts'

const VaultConfig = z.strictObject({ host: z.string().default('local') })
type VaultConfig = z.infer<typeof VaultConfig>

describe('secrets registry', () => {
  it('resolves a custom registration', () => {
    const fetch = async (_config: VaultConfig, _ref: string): Promise<ResolvedSecret> => ({
      fields: { token: 't' },
    })
    registerSecrets('vault-resolves', VaultConfig, fetch)
    const entry = sourceFor('vault-resolves')
    expect(entry.configModel).toBe(VaultConfig)
    expect(entry.fetch).toBe(fetch)
  })

  it('re-registering a name replaces it', () => {
    const first = async (): Promise<ResolvedSecret> => ({ fields: {} })
    const second = async (): Promise<ResolvedSecret> => ({ fields: { a: '1' } })
    registerSecrets('vault-replaces', VaultConfig, first)
    registerSecrets('vault-replaces', VaultConfig, second)
    expect(sourceFor('vault-replaces').fetch).toBe(second)
  })

  it('an unknown source throws naming the known ones', () => {
    registerSecrets('vault-known', VaultConfig, async () => ({ fields: {} }))
    expect(() => sourceFor('nope')).toThrowError(SecretsError)
    expect(() => sourceFor('nope')).toThrowError(/nope/)
    expect(() => sourceFor('nope')).toThrowError(/vault-known/)
  })

  it('knownSources sorts every registered name', () => {
    registerSecrets('zz-last', VaultConfig, async () => ({ fields: {} }))
    registerSecrets('aa-first', VaultConfig, async () => ({ fields: {} }))
    const known = knownSources()
    expect(known.indexOf('aa-first')).toBeLessThan(known.indexOf('zz-last'))
  })

  it('fetchSecret constructs the config from ambient defaults', async () => {
    const seen: VaultConfig[] = []
    registerSecrets('vault-fetch', VaultConfig, async (config, ref) => {
      seen.push(config)
      return { fields: { token: `t-${ref}` } }
    })
    const secret = await fetchSecret('vault-fetch', 'prod')
    expect(secret.fields).toEqual({ token: 't-prod' })
    expect(seen).toEqual([{ host: 'local' }])
  })

  it('fetchSecret on an unknown source throws SecretsError', async () => {
    await expect(fetchSecret('never-registered', 'r')).rejects.toThrowError(SecretsError)
  })
})
