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
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { TokenManager } from './_client.ts'
import { deleteFile } from './drive.ts'

// The Drive-item backends (gdocs, gsheets, gslides) present the same
// synthetic owned/shared tree over the index; stat and unlink differ only
// in the readdir they warm the cache with.
const VIRTUAL_DIRS = new Set(['', 'owned', 'shared'])

// Structural twin of Python's DriveItemAccessor protocol: unlink needs
// only the token manager off the backend accessor.
interface DriveItemAccessor {
  readonly tokenManager: TokenManager
}

type ReaddirFn<A> = (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<string[]>

type StatFn<A> = (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<FileStat>

type UnlinkFn<A> = (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<void>

// The parent directory of an index key, '/' when the key names a root child.
function parentOf(virtualKey: string): string {
  if (!virtualKey.includes('/')) return '/'
  return virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
}

function parentSpec(parentVirtual: string, prefix: string): PathSpec {
  return new PathSpec({
    virtual: parentVirtual,
    directory: parentVirtual,
    resolved: false,
    resourcePath: mountKey(parentVirtual, prefix),
  })
}

/**
 * Build a Drive-item stat over a backend's readdir.
 *
 * @param readdir - backend readdir `(accessor, path, index)` that populates
 *   the index for a parent directory.
 */
export function makeStat<A extends Accessor>(readdir: ReaddirFn<A>): StatFn<A> {
  return async function stat(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<FileStat> {
    const prefix = mountPrefixOf(path.virtual, path.resourcePath)
    const key = path.resourcePath

    if (VIRTUAL_DIRS.has(key)) {
      const name = key !== '' ? key : '/'
      return new FileStat({ name, type: FileType.DIRECTORY })
    }

    if (index === undefined) throw enoent(path.virtual)
    const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
    const entry = await entryOrWarm(index, virtualKey, () =>
      readdir(accessor, parentSpec(parentOf(virtualKey), prefix), index),
    )
    if (entry === null) throw enoent(path.virtual)
    return new FileStat({
      name: entry.vfsName !== '' ? entry.vfsName : entry.name,
      type: FileType.JSON,
      modified: entry.remoteTime,
      size: entry.size,
      extra: {
        doc_id: entry.id,
        doc_name: entry.name,
        ...entry.extra,
      },
    })
  }
}

/**
 * Build a Drive-item unlink over a backend's readdir.
 *
 * @param readdir - backend readdir `(accessor, path, index)` that populates
 *   the index for a parent directory.
 */
export function makeUnlink<A extends Accessor & DriveItemAccessor>(
  readdir: ReaddirFn<A>,
): UnlinkFn<A> {
  return async function unlink(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<void> {
    const prefix = mountPrefixOf(path.virtual, path.resourcePath)
    const key = path.resourcePath
    if (VIRTUAL_DIRS.has(key)) throw eisdir(path.virtual)
    if (index === undefined) throw enoent(path.virtual)
    const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
    const entry = await entryOrWarm(index, virtualKey, () =>
      readdir(accessor, parentSpec(parentOf(virtualKey), prefix), index),
    )
    if (entry === null) throw enoent(path.virtual)
    await deleteFile(accessor.tokenManager, entry.id)
    await index.invalidateDir(parentOf(virtualKey))
    await invalidateAfterUnlink(virtualKey)
  }
}
