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

import { invalidateAncestors, invalidateSubtree } from '@struktoai/mirage-core/cache/context'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { commit } from './commit.ts'
import { exists as foundExists, isDir, keyOf, lookup } from './lookup.ts'
import { dropTree } from './write.ts'

/**
 * Remove a path and everything under it, in one commit.
 *
 * One commit rather than one per file: the Hub's delete op takes a folder, and
 * a per-file loop would leave the repository half-emptied if it failed
 * partway.
 */
export async function rmR(
  accessor: HfHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const rel = path.mountPath.replace(/^\/+|\/+$/g, '')
  const found = await lookup(accessor, index, prefix, keyOf(prefix, rel))
  if (!foundExists(found)) throw enoent(path.virtual)
  const repoPath = accessor.repoPath(rel)
  await commit(accessor, isDir(found) ? { folders: [repoPath] } : { deletions: [repoPath] })
  dropTree(accessor)
  await invalidateSubtree(path)
  await invalidateAncestors(path)
}
