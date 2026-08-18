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
import { invalidateAfterUnlink, invalidateAncestors } from '../../cache/context.ts'
import * as kp from '../../utils/key_prefix.ts'
import type { ObjectStoreDriver, PathFn } from './driver.ts'

/** Build single-key deletion over one driver. */
export function makeUnlink<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): PathFn<A> {
  return async function unlink(accessor, path) {
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const { conn, close } = await driver.connect(accessor)
    try {
      await driver.deleteFile(conn, key)
    } finally {
      await close()
    }
    await invalidateAfterUnlink(path)
    // Deleting the last key under a prefix makes every ancestor that
    // existed only as that prefix disappear, so their cached listings are
    // stale symmetrically to the write case.
    await invalidateAncestors(path)
  }
}

/**
 * Build recursive prefix deletion over one driver.
 *
 * Serves both the `rmR` and `rmdir` slots: on a keyed store an empty
 * directory is its marker object, so removing it and removing a subtree
 * are the same prefix delete.
 */
export function makeRemovePrefix<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
): PathFn<A> {
  return async function removePrefix(accessor, path) {
    const pfx = kp.applyDir(driver.keyPrefixOf(accessor), path.mountPath)
    const { conn, close } = await driver.connect(accessor)
    try {
      await driver.deletePrefix(conn, pfx)
    } finally {
      await close()
    }
    await invalidateAfterUnlink(path)
    // Same rationale as unlink: ancestors that existed only as this
    // prefix are gone now.
    await invalidateAncestors(path)
  }
}
