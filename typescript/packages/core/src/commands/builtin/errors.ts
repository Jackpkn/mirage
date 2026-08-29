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

/**
 * The request never got an HTTP response. Carries the host and port rather
 * than the platform's error text, which differs between runtimes and
 * platforms and so cannot be asserted in a cross-language test.
 * Mirrors Python's mirage.commands.builtin.errors.HttpConnectError.
 */
export class HttpConnectError extends Error {
  readonly host: string
  readonly port: number

  constructor(host: string, port: number) {
    super(`Failed to connect to ${host} port ${String(port)}`)
    this.name = 'HttpConnectError'
    this.host = host
    this.port = port
  }
}

// An invalid -k field specification or ordering letter (GNU sort).
// Mirrors Python's mirage.commands.builtin.errors.SortKeyError.
export class SortKeyError extends Error {}
