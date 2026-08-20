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

import type { CommandRule, AdmissionRules, Grant } from '../../policy/types.ts'
import {
  commandsFromJSON,
  commandsToJSON,
  grantFromJSON,
  grantToJSON,
  ruleFromJSON,
  ruleToJSON,
} from './serialize.ts'

describe('session record codecs', () => {
  it('a rule round-trips and writes mount only when set', () => {
    const bare: CommandRule = { reason: 'no', commands: ['rm'] }
    const data = ruleToJSON(bare)
    expect(data).toEqual({ reason: 'no', commands: ['rm'], paths: [] })
    expect(ruleFromJSON(data)).toEqual({ reason: 'no', commands: ['rm'], paths: [], mount: '' })
    const scoped: CommandRule = {
      reason: 'ro',
      commands: ['git push'],
      paths: ['/repo/*'],
      mount: '/repo',
    }
    expect(ruleToJSON(scoped).mount).toBe('/repo')
    expect(ruleFromJSON(ruleToJSON(scoped))).toEqual(scoped)
    // A record written before a field existed reads with the default.
    expect(ruleFromJSON({ reason: 'x' })).toEqual({
      reason: 'x',
      commands: [],
      paths: [],
      mount: '',
    })
  })

  it('a command tier round-trips and keeps an absent allow list', () => {
    const spec: AdmissionRules = {
      allow: ['ls', 'git log'],
      ask: [{ reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }],
      deny: [{ reason: 'no', commands: ['rm'], paths: [], mount: '' }],
    }
    expect(commandsFromJSON(commandsToJSON(spec))).toEqual(spec)
    const unlisted: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'x', commands: [], paths: [], mount: '' }],
    }
    const data = commandsToJSON(unlisted)
    expect(data.allow).toBeNull()
    expect(commandsFromJSON(data)).toEqual(unlisted)
  })

  it('a grant round-trips', () => {
    const rule: CommandRule = { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }
    const grant: Grant = { decision: 'allow_session', rule, argv: ['git', 'push'], cwd: '/repo' }
    expect(grantFromJSON(grantToJSON(grant))).toEqual(grant)
    expect(grantToJSON(grant)).toEqual({
      decision: 'allow_session',
      rule: { reason: 'sign-off', commands: ['git push'], paths: [] },
      argv: ['git', 'push'],
      cwd: '/repo',
    })
  })
})
