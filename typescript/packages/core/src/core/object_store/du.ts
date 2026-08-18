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
import * as kp from '../../utils/key_prefix.ts'
import { lstripSlash, rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DuEntriesFn, DuSizeFn, ObjectStoreDriver } from './driver.ts'

/**
 * Build the per-object size walk over one driver.
 *
 * Keys are stripped back to mount-relative paths, so a store mounted at
 * a `keyPrefix` reports the paths the user typed rather than the raw
 * keys.
 */
export function makeDuEntries<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
): DuEntriesFn<A> {
  return async function entries(accessor, path, _index) {
    const kpfx = driver.keyPrefixOf(accessor)
    const stem = rstripSlash(kp.apply(kpfx, path.mountPath))
    const found: [string, number][] = []
    let total = 0
    const { conn, close } = await driver.connect(accessor)
    try {
      for await (const entry of driver.listSubtree(conn, stem)) {
        const rel = kp.strip(kpfx, entry.key)
        const size = entry.size ?? 0
        found.push(['/' + lstripSlash(rel), size])
        total += size
      }
    } finally {
      await close()
    }
    found.sort((a, b) => compareCodePoints(a[0], b[0]) || a[1] - b[1])
    return [found, total]
  }
}

/** Build the recursive byte total over one driver. */
export function makeDuSize<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): DuSizeFn<A> {
  return async function size(accessor, path, _index) {
    const kpfx = driver.keyPrefixOf(accessor)
    const stem = rstripSlash(kp.apply(kpfx, path.mountPath))
    let total = 0
    const { conn, close } = await driver.connect(accessor)
    try {
      for await (const entry of driver.listSubtree(conn, stem)) {
        total += entry.size ?? 0
      }
    } finally {
      await close()
    }
    return total
  }
}
