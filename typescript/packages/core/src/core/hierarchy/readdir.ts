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
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { ReaddirFn } from './probe.ts'
import { INVALID, ROOT, type DetectFn, type RouteMatch } from './scope.ts'

export type Lister<A extends Accessor> = (
  accessor: A,
  match: RouteMatch,
) => Promise<[string, IndexEntry][]>

export type Guard<A extends Accessor> = (
  accessor: A,
  match: RouteMatch,
  virtual: string,
) => Promise<void>

/**
 * Build a hierarchy readdir: dispatch, guards, index, name joins.
 *
 * A lister fetches one directory kind and returns `[vfsName, IndexEntry]`
 * pairs; everything else — classification, existence guards, the index probe
 * and write-back, and virtual name construction — happens here, identically
 * for every backend.
 *
 * `listers` holds one lister per directory kind; include `root` for a
 * dynamic mount root. `staticRoot` names fixed top-level entries, for
 * backends whose root never changes; it bypasses the index. `guards` are
 * existence checks that run before the index probe, so a vanished container
 * is ENOENT even on a warm cache. `leafError` is what listing a leaf raises;
 * fixed hierarchies historically answer ENOENT.
 */
export function makeReaddir<A extends Accessor>(
  detect: DetectFn,
  options: {
    listers: Readonly<Record<string, Lister<A>>>
    staticRoot?: readonly string[]
    guards?: Readonly<Record<string, Guard<A>>>
    leafError?: 'enoent' | 'enotdir'
  },
): ReaddirFn<A> {
  const { listers, staticRoot, guards } = options
  const leafError = options.leafError ?? 'enoent'
  return async function readdir(
    accessor: A,
    pathSpec: PathSpec,
    index?: IndexCacheStore,
  ): Promise<string[]> {
    const virtual = pathSpec.virtual
    const prefix = mountPrefixOf(pathSpec.virtual, pathSpec.resourcePath)
    const path = (pathSpec.pattern !== null ? pathSpec.dir : pathSpec).mountPath
    const key = stripSlash(path)
    const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
    const match = detect(path)
    if (match.kind === INVALID) throw enoent(pathSpec)
    if (match.kind === ROOT && staticRoot !== undefined) {
      return staticRoot.map((d) => `${prefix}/${d}`)
    }
    const lister = listers[match.kind]
    if (lister === undefined) {
      if (match.route !== null && match.route.leaf && leafError === 'enotdir') {
        throw enotdir(pathSpec)
      }
      throw enoent(pathSpec)
    }
    const guard = guards?.[match.kind]
    if (guard !== undefined) await guard(accessor, match, virtual)
    if (index !== undefined) {
      const listing = await index.listDir(virtualKey)
      if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    }
    const entries = await lister(accessor, match)
    if (index !== undefined) await index.setDir(virtualKey, entries)
    const stem = rstripSlash(virtualKey)
    return entries.map(([name]) => `${stem}/${name}`)
  }
}
