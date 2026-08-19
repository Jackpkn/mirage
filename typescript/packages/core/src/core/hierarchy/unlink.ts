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

import type { Accessor } from '../../accessor/base.ts'
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { resolveEntry, type ReaddirFn } from './probe.ts'
import { INVALID, type DetectFn } from './scope.ts'

export type DeleteFn<A extends Accessor> = (accessor: A, entry: IndexEntry) => Promise<void>

/**
 * Build a hierarchy unlink: classify, resolve, delete, invalidate.
 *
 * A deleter owns only the backend delete call; classification, the
 * id-resolving parent listing, the directory refusal and the cache
 * invalidation happen here, identically for every backend. `deleters` holds
 * one deleter per leaf kind.
 */
export function makeUnlink<A extends Accessor>(
  detect: DetectFn,
  readdir: ReaddirFn<A>,
  options: { deleters: Readonly<Record<string, DeleteFn<A>>> },
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<void> {
  const { deleters } = options
  return async function unlink(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<void> {
    const match = detect(path)
    const deleter = deleters[match.kind]
    if (deleter === undefined) {
      if (match.kind !== INVALID && !match.scope?.leaf) {
        throw eisdir(path.virtual)
      }
      throw enoent(path.virtual)
    }
    const entry = await resolveEntry(readdir, accessor, path, index)
    if (entry === null || index === undefined) throw enoent(path.virtual)
    await deleter(accessor, entry)
    const prefix = mountPrefixOf(path.virtual, path.resourcePath)
    const key = stripSlash(path.resourcePath)
    const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
    const parentDir = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    await index.invalidateDir(parentDir)
    await invalidateAfterUnlink(virtualKey)
  }
}
