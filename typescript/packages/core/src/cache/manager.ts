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

import { PathSpec } from '../types.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import type { FileCache } from './file/mixin.ts'
import type { IndexCacheStore } from './index/store.ts'

/**
 * Post-mutation cache coherence for one mount.
 *
 * A backend mutation has two cache consequences: the file-cache entry
 * for the path is stale, and the parent directory listing in the index
 * cache (including negative knowledge that the path does not exist) is
 * stale. This class discharges both, synchronously, at the mutation
 * site: core backend mutators report through `cache/context.ts` so
 * invalidation happens before the next command in a pipeline runs
 * instead of after the whole command tree.
 */
export class CacheManager {
  private readonly fileCache: FileCache | null
  private readonly index: IndexCacheStore | null
  private readonly prefix: string
  private readonly cachesReads: boolean

  constructor(
    fileCache: FileCache | null,
    index: IndexCacheStore | null,
    prefix: string,
    cachesReads: boolean,
  ) {
    this.fileCache = fileCache
    this.index = index
    this.prefix = rstripSlash(prefix)
    this.cachesReads = cachesReads
  }

  /**
   * Drop one directory's cached listing.
   *
   * Both spellings of the directory go, because a backend may have keyed
   * it with or without its trailing slash and an eviction that hits no
   * key is silent.
   */
  private async evictDir(virtual: string): Promise<void> {
    if (this.index === null) return
    await this.index.invalidateDir(virtual)
    await this.index.invalidateDir(virtual + '/')
  }

  /**
   * Mount-absolute key for a path, derived rather than inferred.
   *
   * Only `virtual` is read, and the key is rebuilt against this manager's own
   * prefix, exactly as `Mount.executeOp` rebuilds one before handing a path to
   * a backend. The caller's `resourcePath` is deliberately ignored: it is not
   * a fact this class can trust, because `PathSpec.fromStrPath` fabricates one
   * ("assumed root-mounted") for any caller that does not know its mount.
   *
   * The earlier version inferred which convention had arrived by comparing the
   * two strings, which cannot be done: under a `/d` mount a mount-relative `/d`
   * and an absolute `/d` are the same characters naming different files.
   * Inferring wrong is quiet rather than loud -- a key one level off simply
   * evicts nothing -- which is why it survived. Deriving asks no question that
   * has no answer.
   *
   * Mirrors Python `CacheManager._virtual`.
   */
  private virtual(path: string | PathSpec): string {
    const virtual = path instanceof PathSpec ? path.virtual : path
    const key = mountKey(virtual, this.prefix)
    if (key === '') return this.prefix === '' ? '/' : this.prefix
    return `${this.prefix}/${key}`
  }

  /**
   * Return cached bytes for `path` if present, else null.
   *
   * Lookup only, never fetches from the backend. The single read-cache
   * check the shared read-through wrappers (`cache/read_through.ts`) read
   * through, so warm reads are served from the file cache without the
   * command knowing about it. No-op for local or non-caching mounts.
   */
  async cachedBytes(path: PathSpec): Promise<Uint8Array | null> {
    if (!this.cachesReads || this.fileCache === null) return null
    const virtual = this.virtual(path)
    if (await this.fileCache.exists(virtual)) {
      return this.fileCache.get(virtual)
    }
    return null
  }

  /** Invalidate caches after a write to `path` (resource-relative). */
  async invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    const virtual = this.virtual(path)
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(virtual)
    }
    await this.invalidateParent(virtual)
  }

  /** Invalidate caches after a deletion of `path` (resource-relative). */
  async invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    const virtual = this.virtual(path)
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(virtual)
    }
    await this.evictDir(virtual)
    await this.invalidateParent(virtual)
  }

  /**
   * Drop `path` and everything cached beneath it.
   *
   * For an observed change that names a scope rather than a file: a push
   * notification often says only which folder moved, and the listings below it
   * were cached independently, so evicting the path and its parent leaves
   * stale entries one level down. The cheaper `invalidateAfterWrite` cannot be
   * widened to do this, because it also runs on every ordinary write, where a
   * file has no subtree to drop.
   *
   * Mirrors Python `CacheManager.invalidate_subtree`.
   */
  async invalidateSubtree(path: string | PathSpec): Promise<void> {
    const virtual = this.virtual(path)
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(virtual)
      await this.fileCache.evictPrefix(rstripSlash(virtual) + '/')
    }
    if (this.index !== null) await this.index.invalidatePrefix(virtual)
    await this.evictDir(virtual)
    await this.invalidateParent(virtual)
  }

  /**
   * Evict the listing of every directory above `path`'s parent.
   *
   * `invalidateAfterWrite` refreshes the immediate parent only. A keyed store
   * materializes every missing level of a key in a single put, so the listings
   * further up gained entries too and would keep serving the pre-write view
   * until the index TTL expires. A backend with real directories cannot gain a
   * level that way, so there this is a handful of spare evictions.
   */
  async invalidateAncestors(path: string | PathSpec): Promise<void> {
    if (this.index === null) return
    const virtual = this.virtual(path)
    let parent = virtual.slice(0, Math.max(virtual.lastIndexOf('/'), 0))
    while (parent !== '' && parent !== this.prefix) {
      parent = parent.slice(0, Math.max(parent.lastIndexOf('/'), 0))
      await this.evictDir(parent === '' ? '/' : parent)
    }
  }

  /**
   * Drop every cached body under this mount, path unspecified.
   *
   * For a mutation that names no path: an account CLI writes to its service by
   * id, so nothing here can say which file changed, only that this mount's
   * bytes may no longer match the service. Clearing the listing alone is not
   * enough, because an already-read body is served warm and would keep
   * answering with the pre-write content.
   *
   * Over-evicts when this mount is the root and another mount sits beneath it,
   * since keys are compared by prefix. That costs a refetch, which is the safe
   * direction to be wrong in.
   */
  async dropPrefix(): Promise<void> {
    if (!this.cachesReads || this.fileCache === null) return
    await this.fileCache.evictPrefix(this.prefix + '/')
  }

  private async invalidateParent(virtual: string): Promise<void> {
    const lastSlash = virtual.lastIndexOf('/')
    await this.evictDir(lastSlash > 0 ? virtual.slice(0, lastSlash) : '/')
  }
}
