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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type Reader<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<Uint8Array>

export interface ReadWindow {
  limit?: number | null
  offset?: number | null
}

export type WindowedReader<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  window: ReadWindow,
) => Promise<Uint8Array>

/**
 * Build a hierarchy read: classify, dispatch, refuse the rest.
 *
 * Readers own their fetches, guards and rendering; the kit owns the
 * classification and the ENOENT funnel for every non-file shape. `readers`
 * holds one reader per leaf kind. `windowed` holds readers for kinds whose
 * content is windowed at the source (postgres rows take a row limit/offset
 * the backend pushes into the query); they receive the caller's window,
 * which every plain reader ignores, matching a filesystem read that has no
 * row notion.
 */
export function makeRead<A extends Accessor>(
  detect: DetectFn,
  readers: Readonly<Record<string, Reader<A>>>,
  windowed: Readonly<Record<string, WindowedReader<A>>> = {},
): (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
  window?: ReadWindow,
) => Promise<Uint8Array> {
  return async function read(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
    window: ReadWindow = {},
  ): Promise<Uint8Array> {
    const match = detect(path)
    const windowReader = windowed[match.kind]
    if (windowReader !== undefined) return windowReader(accessor, match, path, index, window)
    const reader = readers[match.kind]
    if (reader === undefined) {
      // A directory that exists by construction (the root, or a
      // probed=false scope) read as a file is EISDIR. Everything else is
      // reported absent: a matched shape alone is no proof the node
      // exists, and GNU says "No such file" for a missing name, "Is a
      // directory" only for a real one.
      if (
        match.kind === ROOT ||
        (match.scope !== null && !match.scope.leaf && !match.scope.probed)
      ) {
        throw eisdir(path)
      }
      throw enoent(path)
    }
    return reader(accessor, match, path, index)
  }
}
