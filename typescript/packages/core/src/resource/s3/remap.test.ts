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
import { RegisteredCommand } from '../../commands/config.ts'
import { CommandSpec } from '../../commands/spec/types.ts'
import { ResourceName } from '../../types.ts'
import { remapCommandsResource } from './remap.ts'

const FN = () => null

describe('remapCommandsResource', () => {
  it('returns immutable command definitions for S3 aliases', () => {
    const original = new RegisteredCommand({
      name: 'cat',
      spec: new CommandSpec(),
      resource: ResourceName.S3,
      fn: FN,
    })

    const [remapped] = remapCommandsResource([original], ResourceName.R2)

    expect(remapped).not.toBe(original)
    expect(remapped?.resource).toBe(ResourceName.R2)
    expect(Object.isFrozen(remapped)).toBe(true)
    expect(() => ((remapped as unknown as { name: string }).name = 'tail')).toThrow()
  })

  it('keeps commands already registered for another resource', () => {
    const original = new RegisteredCommand({
      name: 'cat',
      spec: new CommandSpec(),
      resource: ResourceName.RAM,
      fn: FN,
    })

    expect(remapCommandsResource([original], ResourceName.R2)[0]).toBe(original)
  })
})
