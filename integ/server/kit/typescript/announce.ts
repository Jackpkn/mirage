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

import { advertiseHost, authorityHost } from './bind.ts'
import type { Announce } from './types.ts'

export const ANNOUNCE_SUFFIX = '_URL'

// The runners strip this prefix off the fake's first stdout line to learn the
// endpoint, so it is one regex in one place rather than a per-service literal.
export const ANNOUNCE_RE = /^[A-Z0-9_]+_URL=/

export function announceFor(service: string, port: number): Announce {
  const token = `${service.toUpperCase().replace(/-/g, '_')}${ANNOUNCE_SUFFIX}`
  return { token, url: `http://${authorityHost(advertiseHost())}:${String(port)}` }
}

export function emit(a: Announce): void {
  process.stdout.write(`${a.token}=${a.url}\n`)
}
