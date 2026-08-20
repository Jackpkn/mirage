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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import { assertListed, listedSize, resolveEntry, type ReaddirFn } from './probe.ts'
import type { Guard } from './readdir.ts'
import { ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type ExtraFn = (match: ScopeMatch) => Record<string, string>

export type StatHook<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<FileStat>

export type EntryStatFn = (match: ScopeMatch, path: PathSpec, entry: IndexEntry) => FileStat

/**
 * The shape most id-addressed nodes share, keyed by an id field: name from
 * the entry's `vfsName`, size and modified straight off the listing, and the
 * entry's id under `idField` in `extra`. A kind whose shape differs writes
 * its own `EntryStatFn` instead.
 */
export function entryStat(idField: string, filetype: FileType): EntryStatFn {
  return function build(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
    return new FileStat({
      name: entry.vfsName,
      type: filetype,
      size: entry.size,
      modified: entry.remoteTime !== '' ? entry.remoteTime : null,
      extra: { [idField]: entry.id },
    })
  }
}

/**
 * Build a hierarchy stat: existence probes and shapes per scope.
 *
 * Directories answer as themselves once proven to exist; leaves prove
 * existence through their parent's listing and pick up any size that listing
 * recorded. A guard replaces the parent-listing probe for kinds whose
 * existence the API answers directly; an override replaces the whole shape
 * for kinds with bespoke stats. `extras` derives per-kind `FileStat.extra`
 * payloads from the slots. `entryStats` are per-kind shapes built from the
 * path's own index entry, for id-addressed backends whose listing already
 * carries the stat (Drive-item trees); the kit resolves the entry through the
 * parent readdir and an absent entry is ENOENT.
 */
export function makeStat<A extends Accessor>(
  detect: DetectFn,
  readdir: ReaddirFn<A>,
  options: {
    guards?: Readonly<Record<string, Guard<A>>>
    extras?: Readonly<Record<string, ExtraFn>>
    overrides?: Readonly<Record<string, StatHook<A>>>
    entryStats?: Readonly<Record<string, EntryStatFn>>
  } = {},
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<FileStat> {
  const { guards, extras, overrides, entryStats } = options
  return async function stat(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<FileStat> {
    const virtual = path.virtual
    const match = detect(path)
    if (match.kind === ROOT) return new FileStat({ name: '/', type: FileType.DIRECTORY })
    const scope = match.scope
    if (scope === null) throw enoent(path)
    const override = overrides?.[match.kind]
    if (override !== undefined) return override(accessor, match, path, index)
    const guard = guards?.[match.kind]
    const entryFn = entryStats?.[match.kind]
    if (entryFn !== undefined) {
      if (guard !== undefined) await guard(accessor, match, virtual)
      const entry = await resolveEntry(readdir, accessor, path, index)
      if (entry === null) throw enoent(path.virtual)
      return entryFn(match, path, entry)
    }
    if (guard !== undefined) {
      await guard(accessor, match, virtual)
    } else if (scope.probed) {
      await assertListed(readdir, accessor, path, index)
    }
    const name = stripSlash(path.resourcePath).split('/').pop() ?? ''
    const extraFn = extras?.[match.kind]
    const extra = extraFn !== undefined ? extraFn(match) : {}
    if (!scope.leaf) return new FileStat({ name, type: FileType.DIRECTORY, extra })
    return new FileStat({
      name,
      type: scope.filetype ?? FileType.JSON,
      size: await listedSize(index, path),
      extra,
    })
  }
}
