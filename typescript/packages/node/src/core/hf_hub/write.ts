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

import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import { record } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { commit } from './commit.ts'

/**
 * Forget the cached listing after a commit changed it.
 *
 * The accessor's tree IS the mount's listing, so a write that does not clear
 * it leaves find, du and every no-index read answering from the repository as
 * it was before the commit.
 */
export function dropTree(accessor: HfHubAccessor): void {
  accessor.tree = new Map()
  accessor.treeLoaded = false
  accessor.rowsCache = null
}

/** Add or replace one file, as a commit on the mount's revision. */
export async function write(
  accessor: HfHubAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const start = Date.now()
  await commit(accessor, {
    additions: [{ path: accessor.repoPath(path.mountPath), data }],
  })
  record('write', path.virtual, accessor.resourceName, data.length, start)
  dropTree(accessor)
  await invalidateAfterWrite(path)
  await invalidateAncestors(path)
}
