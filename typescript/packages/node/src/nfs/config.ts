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

export const DEFAULT_PORT = 20490
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_IDLE_FLUSH_SECONDS = 5.0
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024

/** Knobs for one NFS-backed mount. */
export interface NFSConfigInit {
  /**
   * Address the server binds. Loopback only by default: an NFSv3
   * export has no authentication of its own, so binding anywhere
   * reachable would publish the workspace unguarded.
   */
  host?: string
  /**
   * TCP port serving both the MOUNT and NFS programs, so no
   * portmapper is needed. 0 asks the OS for a free port.
   */
  port?: number
  /**
   * How long a handle's buffered writes may sit before the adapter
   * flushes them. The server answers every write as durable and
   * forwards no COMMIT, so this bounds the window in which a crash
   * loses acknowledged writes.
   */
  idleFlushSeconds?: number
  /**
   * Per-handle ceiling that forces an early flush, so a client that
   * never stops writing cannot grow the buffer without bound.
   */
  maxBufferedBytes?: number
}

export class NFSConfig {
  readonly host: string
  readonly port: number
  readonly idleFlushSeconds: number
  readonly maxBufferedBytes: number

  constructor(init: NFSConfigInit = {}) {
    this.host = init.host ?? DEFAULT_HOST
    this.port = init.port ?? DEFAULT_PORT
    this.idleFlushSeconds = init.idleFlushSeconds ?? DEFAULT_IDLE_FLUSH_SECONDS
    this.maxBufferedBytes = init.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new RangeError(`port out of range: ${String(this.port)}`)
    }
    if (this.idleFlushSeconds <= 0) {
      throw new RangeError(`idleFlushSeconds must be positive: ${String(this.idleFlushSeconds)}`)
    }
    if (this.maxBufferedBytes <= 0) {
      throw new RangeError(`maxBufferedBytes must be positive: ${String(this.maxBufferedBytes)}`)
    }
    // The twin of python's frozen dataclass, the way core's stat rows are
    // frozen: the server is started from these values, so a later write
    // would describe a server that is not running.
    Object.freeze(this)
  }
}
