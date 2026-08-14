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

import { isEnoent } from '../../utils/errors.ts'
import type { IndexEntry } from './config.ts'
import type { IndexCacheStore } from './store.ts'

/**
 * Resolve an index entry, listing the parent directory once when the lookup
 * is cold.
 *
 * Id-addressed backends (Drive, Box, Dropbox, Gmail) can only turn a path into
 * an id through the index, so a cold lookup has to warm it from the parent's
 * listing and retry. Every such backend had grown its own copy of that block;
 * this is the one place that decides what a failed listing means.
 *
 * A parent that is simply absent is not an error here — the caller reports
 * ENOENT against the operand, which is the path GNU names (`rm nodir/f` says
 * "cannot remove 'nodir/f'", not "nodir"). Every other failure propagates: an
 * expired token or a dropped connection reported as "no such file" both
 * misdiagnoses the fault and hides that it is worth retrying.
 *
 * Mirrors Python's entry_or_warm.
 *
 * @param index - the index to read, and to warm through `warm`.
 * @param virtualKey - the index key being resolved.
 * @param warm - lists the parent directory, populating the index; null when
 *   the key has no distinct parent to list.
 */
export async function entryOrWarm(
  index: IndexCacheStore,
  virtualKey: string,
  warm: (() => Promise<unknown>) | null,
): Promise<IndexEntry | null> {
  const hit = await index.get(virtualKey)
  if (hit.entry !== undefined && hit.entry !== null) return hit.entry
  if (warm === null) return null
  try {
    await warm()
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  const warmed = await index.get(virtualKey)
  return warmed.entry ?? null
}
