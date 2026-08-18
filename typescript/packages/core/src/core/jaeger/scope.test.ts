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
import { detectScope } from './scope.ts'

const TRACE = 'a'.repeat(32)

describe('jaeger detectScope', () => {
  it.each([
    ['', 'root'],
    ['/', 'root'],
    ['services', 'services'],
    ['services/checkout', 'service'],
    ['services/checkout/operations.json', 'operations'],
    ['services/checkout/traces', 'traces'],
    [`services/checkout/traces/${TRACE}.json`, 'trace'],
    ['traces', 'invalid'],
    ['services/checkout/traces/deep/nested.json', 'invalid'],
    ['services/checkout/unknown.json', 'invalid'],
    // A malformed trace id fails the route's codec, so the path never
    // classifies as a trace at all.
    ['services/checkout/traces/nothex.json', 'invalid'],
    ['services/.hidden', 'invalid'],
  ])('classifies %s as %s', (path, kind) => {
    expect(detectScope(path).kind).toBe(kind)
  })

  it('carries service and trace id', () => {
    const match = detectScope(`services/checkout/traces/${TRACE}.json`)
    expect(match.captures).toEqual({ service: 'checkout', trace_id: TRACE })
  })

  it('carries the service without a trace', () => {
    const match = detectScope('services/checkout/traces')
    expect(match.captures).toEqual({ service: 'checkout' })
  })
})
