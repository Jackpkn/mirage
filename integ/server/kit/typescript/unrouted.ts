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

import type { Reply } from './types.ts'

// Every fake but github 404'd an unimplemented endpoint in silence, so a route
// nobody wrote read back to the caller as a legitimate empty result and to the
// log as nothing at all. One line on stderr, one shape, and CI greps for it.
export function unroutedLine(service: string, method: string, path: string): string {
  return `${service} fake: no route for ${method} ${path}`
}

export function unrouted(service: string, method: string, path: string): Reply {
  process.stderr.write(`${unroutedLine(service, method, path)}\n`)
  return { status: 404, body: { error: 'not_found', method, path } }
}
