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

import { FileType } from '../../types.ts'
import { Codec } from '../hierarchy/codec.ts'
import { Capture, Route } from '../hierarchy/route.ts'
import { makeDetectScope } from '../hierarchy/scope.ts'
import { isTraceId } from './client.ts'

export const OPERATIONS_FILE = 'operations.json'
export const TOP_LEVEL_DIRS = ['services']

// A malformed id cannot name an existing trace, so it fails the route match
// outright and reads as ENOENT rather than the API's 400 "invalid length for
// TraceID".
const TRACE_FILE = new Codec({ suffix: '.json', validate: isTraceId })

// The tree is service-scoped because Jaeger's search API requires a service:
// there is no endpoint that lists every trace.
const ROUTES: readonly Route[] = [
  new Route({ kind: 'services', segments: ['services'], probed: false }),
  new Route({ kind: 'service', segments: ['services', new Capture('service')] }),
  new Route({
    kind: 'operations',
    segments: ['services', new Capture('service'), OPERATIONS_FILE],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Route({ kind: 'traces', segments: ['services', new Capture('service'), 'traces'] }),
  new Route({
    kind: 'trace',
    segments: ['services', new Capture('service'), 'traces', new Capture('trace_id', TRACE_FILE)],
    leaf: true,
    filetype: FileType.JSON,
  }),
]

export const detectScope = makeDetectScope(ROUTES)
