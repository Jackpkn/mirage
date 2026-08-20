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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { resolveEntry, type ReaddirFn } from './probe.ts'
import { INVALID, ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type Lister<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
) => Promise<[string, IndexEntry][] | null>

export type EntryLister<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  entry: IndexEntry,
) => Promise<[string, IndexEntry][]>

export type Guard<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  virtual: string,
) => Promise<void>

/**
 * Build a hierarchy readdir: dispatch, guards, index, name joins.
 *
 * A lister fetches one directory kind and returns `[vfsName, IndexEntry]`
 * pairs; everything else — classification, existence guards, the index probe
 * and write-back, and virtual name construction — happens here, identically
 * for every backend. A dot-prefixed name is dropped from the listing: the
 * classifier refuses every dot-leading segment, so listing one would
 * advertise a path that stat, read and child readdir all report absent.
 * A lister may answer null instead of a listing: the directory's container
 * does not exist, reported as ENOENT on the virtual path.
 *
 * An entry lister is for a directory whose existence and contents are
 * already proven by its parent's listing: the kit resolves the directory's
 * own index entry through `resolveEntry` (warming parent listings, each one
 * cached) and hands it over, so entering a directory a traversal just listed
 * costs no API call at all. A container lister that instead re-fetched its
 * ancestor chain per directory made a recursive walk quadratic in listing
 * payloads. The facts a child listing needs beyond the API's own answers
 * ride the parent listing's `IndexEntry.extra` (trello stashes each
 * `card.json` size on the card's directory entry).
 *
 * `listers` holds one lister per directory kind; include `root` for a
 * dynamic mount root. `entryListers` holds listers for kinds resolved
 * through their parent's listing; a kind appears in exactly one of the two
 * tables. `staticRoot` names fixed top-level entries, for backends whose
 * root never changes; it bypasses the index. `guards` are existence checks
 * that run before the index probe, so a vanished container is ENOENT even on
 * a warm cache. `leafError` is what listing a leaf raises; fixed hierarchies
 * historically answer ENOENT.
 */
export function makeReaddir<A extends Accessor>(
  detect: DetectFn,
  options: {
    listers: Readonly<Record<string, Lister<A>>>
    entryListers?: Readonly<Record<string, EntryLister<A>>>
    staticRoot?: readonly string[]
    guards?: Readonly<Record<string, Guard<A>>>
    leafError?: 'enoent' | 'enotdir'
  },
): ReaddirFn<A> {
  const { listers, staticRoot, guards } = options
  const entryListers = options.entryListers ?? {}
  const leafError = options.leafError ?? 'enoent'
  const overlap = Object.keys(listers).filter((kind) => entryListers[kind] !== undefined)
  if (overlap.length > 0) {
    throw new Error(`kinds in both lister tables: ${overlap.sort(compareCodePoints).join(', ')}`)
  }
  return async function readdir(
    accessor: A,
    pathSpec: PathSpec,
    index?: IndexCacheStore,
  ): Promise<string[]> {
    // Entry resolution and the parent-listing warm both read what readdir
    // just wrote, so a caller with no cache still needs one for the
    // duration of the call.
    const store = index ?? new RAMIndexCacheStore()
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
    const entryLister = entryListers[match.kind]
    if (lister === undefined && entryLister === undefined) {
      if (match.scope !== null && match.scope.leaf && leafError === 'enotdir') {
        throw enotdir(pathSpec)
      }
      throw enoent(pathSpec)
    }
    const guard = guards?.[match.kind]
    if (guard !== undefined) await guard(accessor, match, virtual)
    const listing = await store.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    let listed: [string, IndexEntry][]
    if (entryLister !== undefined) {
      const own = await resolveEntry(
        readdir,
        accessor,
        new PathSpec({
          virtual: virtualKey,
          directory: virtualKey,
          resolved: false,
          resourcePath: mountKey(virtualKey, prefix),
        }),
        store,
      )
      if (own === null) throw enoent(pathSpec)
      listed = await entryLister(accessor, match, own)
    } else if (lister !== undefined) {
      const maybe = await lister(accessor, match)
      if (maybe === null) throw enoent(pathSpec)
      listed = maybe
    } else {
      throw enoent(pathSpec)
    }
    const entries = listed.filter(([name]) => !name.startsWith('.'))
    await store.setDir(virtualKey, entries)
    const stem = rstripSlash(virtualKey)
    return entries.map(([name]) => `${stem}/${name}`)
  }
}
