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

import { IndexEntry, ResourceType } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { listingError } from '@struktoai/mirage-core/utils/errors'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { HfAccessor } from '../../accessor/hf.ts'
import { SCOPE_ERROR } from './constants.ts'
import { isNotFound } from './util.ts'

async function isFile(accessor: HfAccessor, key: string): Promise<boolean> {
  const op = await accessor.operator()
  try {
    return !(await op.stat(stripSlash(key))).isDirectory()
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

async function isDir(accessor: HfAccessor, key: string): Promise<boolean> {
  const op = await accessor.operator()
  try {
    return (await op.stat(`${stripSlash(key)}/`)).isDirectory()
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

export async function readdir(
  accessor: HfAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let target = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && target.startsWith(prefix)) {
    const rest = target.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) {
      target = rest || '/'
    }
  }
  const virtualKey = rstripSlash(prefix !== '' ? `${prefix}${target}` : target) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }
  const strippedTarget = stripSlash(target)
  const listPath = strippedTarget !== '' ? `${strippedTarget}/` : '/'
  const op = await accessor.operator()
  const names: string[] = []
  const dirKeys = new Set<string>()
  const sizes = new Map<string, number | null>()
  let entries
  try {
    entries = await op.list(listPath)
  } catch (err) {
    if (isNotFound(err)) {
      throw await listingError(
        path,
        target,
        (key) => isFile(accessor, key),
        (key) => isDir(accessor, key),
      )
    }
    throw err
  }
  if (entries.length === 0 && strippedTarget !== '') {
    // Nothing stands for the directory itself here: the tree API lists
    // children only, and the hf service refuses a directory marker
    // client-side (create_dir=false), so a bucket directory exists exactly
    // while it holds a key. The Hub answers a missing subpath with 200 and
    // [], which the lister reports as an empty result rather than raising,
    // so the NotFound arm above never fired and `ls /hf/never` rendered an
    // empty directory and exited 0.
    //
    // Both halves are thrown, ENOENT included. hf cannot tell an emptied
    // directory from one the repo never had, and `stat` already resolves
    // that ambiguity toward absence (it lists the prefix and raises ENOENT
    // when nothing is under it), so keeping the empty listing here is what
    // made `ls` and `stat` disagree about the same path. The mount root is
    // exempt: it exists because it is mounted.
    throw await listingError(
      path,
      target,
      (key) => isFile(accessor, key),
      (key) => isDir(accessor, key),
    )
  }
  for (const entry of entries) {
    const relative = entry.path()
    if (relative === '' || relative === listPath) continue
    const isDir = relative.endsWith('/')
    const base = `/${rstripSlash(relative)}`
    names.push(base)
    if (isDir) {
      dirKeys.add(base)
    } else {
      const meta = entry.metadata()
      const length = meta.contentLength
      sizes.set(base, length !== null ? Number(length) : null)
    }
  }
  // The Hub tree API carries a size for every file (for LFS files it is
  // the object size, not the pointer's); when the lister omits the
  // metadata, one stat per affected file fills the gap so the index
  // never caches an unknown size.
  for (const [base, size] of sizes) {
    if (size !== null) continue
    const md = await op.stat(stripSlash(base))
    sizes.set(base, md.contentLength !== null ? Number(md.contentLength) : null)
  }
  names.sort(compareCodePoints)
  if (names.length > SCOPE_ERROR) {
    console.warn(
      `hf readdir: ${virtualKey} returned ${String(names.length)} entries (limit ${String(SCOPE_ERROR)})`,
    )
  }
  const virtualEntries = names
    .map((e) => (prefix !== '' ? `${prefix}${e}` : e))
    .sort(compareCodePoints)
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = names.map((e) => {
      const name = e.split('/').pop() ?? e
      if (dirKeys.has(e)) {
        return [name, new IndexEntry({ id: e, name, resourceType: ResourceType.FOLDER })]
      }
      return [
        name,
        new IndexEntry({
          id: e,
          name,
          resourceType: ResourceType.FILE,
          size: sizes.get(e) ?? null,
        }),
      ]
    })
    await index.setDir(virtualKey, indexEntries)
  }
  return virtualEntries
}
