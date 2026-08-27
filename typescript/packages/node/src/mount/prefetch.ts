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

// How long prefetched bytes for size-unknown files outlive their handle,
// so a release-then-stat burst (ls right after cat) neither refetches nor
// reports an unknown size. Mirrors python's PREFETCH_TTL.
export const PREFETCH_TTL_MS = 30_000

interface PrefetchEntry {
  data: Uint8Array
  expires: number
}

/**
 * Bytes of size-unknown files, held briefly past their handle.
 *
 * A backend that cannot answer a size until the content is fetched would
 * otherwise refetch on every stat that follows a read, which over a
 * mount is one API call per `ls -l` entry. Holding the bytes for a short
 * window makes the release-then-stat burst free without pinning memory
 * for the life of the mount.
 *
 * Sync on purpose: expiry is a clock read and eviction is a map delete,
 * so nothing here awaits. Only the fill is async, and it lives in the
 * core, which is the layer that knows how to reach a backend.
 *
 * The one asymmetry with python's twin is {@link claim}: a FUSE mount
 * there runs `nothreads=True`, so two opens of one path cannot race and
 * python needs no inflight map. Here they can, and a second open must
 * join the first fetch rather than start a second.
 */
export class PrefetchCache {
  private readonly entries = new Map<string, PrefetchEntry>()
  private readonly inflight = new Map<string, Promise<Uint8Array | null>>()
  private readonly ttlMs: number

  constructor(ttlMs: number = PREFETCH_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /**
   * The cached bytes for a path, when they are still fresh. A stale
   * entry is dropped rather than returned, so a caller never has to
   * check the clock itself.
   */
  get(path: string): Uint8Array | null {
    const entry = this.entries.get(path)
    if (entry === undefined) return null
    if (entry.expires <= Date.now()) {
      this.entries.delete(path)
      return null
    }
    return entry.data
  }

  /** Hold a path's bytes for the cache's TTL. */
  put(path: string, data: Uint8Array): void {
    this.entries.set(path, { data, expires: Date.now() + this.ttlMs })
  }

  /**
   * Drop the entries for paths whose content may have changed. Every
   * mutation the core performs calls this: serving a stale read after a
   * write is worse than the refetch it saves.
   */
  invalidate(...paths: string[]): void {
    for (const path of paths) this.entries.delete(path)
  }

  /** Forget everything held. */
  clear(): void {
    this.entries.clear()
  }

  /**
   * Run `fill` for a path unless one is already running for it, in which
   * case join that one. The result is cached when it is non-null; a
   * failed fetch caches nothing, so the next open retries.
   */
  claim(path: string, fill: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
    const running = this.inflight.get(path)
    if (running !== undefined) return running
    const promise = (async (): Promise<Uint8Array | null> => {
      try {
        const data = await fill()
        if (data !== null) this.put(path, data)
        return data
      } finally {
        this.inflight.delete(path)
      }
    })()
    this.inflight.set(path, promise)
    return promise
  }
}
