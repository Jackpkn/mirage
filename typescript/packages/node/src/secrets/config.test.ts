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

import { AWSSMConfig, DotenvConfig, EnvConfig } from './config.ts'

describe('source configs', () => {
  it('all three parse from ambient defaults', () => {
    expect(EnvConfig.parse({})).toEqual({})
    expect(DotenvConfig.parse({})).toEqual({ path: '.env' })
    expect(AWSSMConfig.parse({})).toEqual({})
  })

  it('each refuses an unknown key', () => {
    expect(() => EnvConfig.parse({ bogus: 1 })).toThrowError()
    expect(() => DotenvConfig.parse({ bogus: 1 })).toThrowError()
    expect(() => AWSSMConfig.parse({ bogus: 1 })).toThrowError()
  })

  it('aws-sm carries the five shared auth fields', () => {
    const cfg = AWSSMConfig.parse({
      region: 'us-east-1',
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: 'sk',
      awsSessionToken: 'st',
      awsProfile: 'dev',
    })
    expect(cfg.region).toBe('us-east-1')
    expect(cfg.awsProfile).toBe('dev')
  })
})
