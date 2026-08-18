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
import { enoent } from '../../utils/errors.ts'
import type { DetectFn, RouteMatch } from './scope.ts'

export type Reader<A extends Accessor> = (
  accessor: A,
  match: RouteMatch,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<Uint8Array>

/**
 * Build a hierarchy read: classify, dispatch, refuse the rest.
 *
 * Readers own their fetches, guards and rendering; the kit owns the
 * classification and the ENOENT funnel for every non-file shape. `readers`
 * holds one reader per leaf kind.
 */
export function makeRead<A extends Accessor>(
  detect: DetectFn,
  readers: Readonly<Record<string, Reader<A>>>,
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<Uint8Array> {
  return async function read(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<Uint8Array> {
    const match = detect(path)
    const reader = readers[match.kind]
    if (reader === undefined) throw enoent(path)
    return reader(accessor, match, path, index)
  }
}
