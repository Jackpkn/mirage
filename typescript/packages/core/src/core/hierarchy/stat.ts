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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import { assertListed, listedSize, type ReaddirFn } from './probe.ts'
import type { Guard } from './readdir.ts'
import { ROOT, type DetectFn, type RouteMatch } from './scope.ts'

export type ExtraFn = (match: RouteMatch) => Record<string, string>

export type StatHook<A extends Accessor> = (
  accessor: A,
  match: RouteMatch,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<FileStat>

/**
 * Build a hierarchy stat: existence probes and shapes per route.
 *
 * Directories answer as themselves once proven to exist; leaves prove
 * existence through their parent's listing and pick up any size that listing
 * recorded. A guard replaces the parent-listing probe for kinds whose
 * existence the API answers directly; an override replaces the whole shape
 * for kinds with bespoke stats. `extras` derives per-kind `FileStat.extra`
 * payloads from the captures.
 */
export function makeStat<A extends Accessor>(
  detect: DetectFn,
  readdir: ReaddirFn<A>,
  options: {
    guards?: Readonly<Record<string, Guard<A>>>
    extras?: Readonly<Record<string, ExtraFn>>
    overrides?: Readonly<Record<string, StatHook<A>>>
  } = {},
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<FileStat> {
  const { guards, extras, overrides } = options
  return async function stat(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<FileStat> {
    const virtual = path.virtual
    const match = detect(path)
    if (match.kind === ROOT) return new FileStat({ name: '/', type: FileType.DIRECTORY })
    const route = match.route
    if (route === null) throw enoent(path)
    const override = overrides?.[match.kind]
    if (override !== undefined) return override(accessor, match, path, index)
    const guard = guards?.[match.kind]
    if (guard !== undefined) {
      await guard(accessor, match, virtual)
    } else if (route.probed) {
      await assertListed(readdir, accessor, path, index)
    }
    const name = stripSlash(path.resourcePath).split('/').pop() ?? ''
    const extraFn = extras?.[match.kind]
    const extra = extraFn !== undefined ? extraFn(match) : {}
    if (!route.leaf) return new FileStat({ name, type: FileType.DIRECTORY, extra })
    return new FileStat({
      name,
      type: route.filetype ?? FileType.JSON,
      size: await listedSize(index, path),
      extra,
    })
  }
}
