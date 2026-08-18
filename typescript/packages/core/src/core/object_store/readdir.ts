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
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import { listingError } from '../../utils/errors.ts'
import * as kp from '../../utils/key_prefix.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { ObjectStoreDriver, ReaddirFn } from './driver.ts'

async function probeFile<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  kpfx: string,
  key: string,
): Promise<boolean> {
  return (await driver.head(conn, kp.apply(kpfx, key))) !== null
}

async function probeDir<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  kpfx: string,
  key: string,
): Promise<boolean> {
  return driver.probePrefix(conn, kp.applyDir(kpfx, key))
}

/** Build a prefix listing with index write-back over one driver. */
export function makeReaddir<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): ReaddirFn<A> {
  return async function readdir(accessor, path, index) {
    const prefix = mountPrefixOf(path.virtual, path.resourcePath)
    // When called from resolveGlob with a pattern (e.g. *.txt), use
    // path.directory for the listing. Direct callers (ls, ops) pass
    // pattern=null so path.virtual is used.
    const virtual = path.pattern !== null ? path.directory : path.virtual
    const rawPath =
      prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual
    const virtualKey = rawPath === '/' ? '/' : rstripSlash(rawPath) || '/'
    const rawFullKey = prefix !== '' ? `${prefix}${virtualKey}` : virtualKey
    const fullVirtualKey = rstripSlash(rawFullKey) || '/'
    if (index !== undefined) {
      const listing = await index.listDir(fullVirtualKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries
      }
    }
    const kpfx = driver.keyPrefixOf(accessor)
    const pfx = kp.applyDir(kpfx, rawPath)
    const names: string[] = []
    const dirKeys = new Set<string>()
    const sizes = new Map<string, number | null>()
    const times = new Map<string, string>()
    let sawKey = false
    const { conn, close } = await driver.connect(accessor)
    try {
      for await (const child of driver.listChildren(conn, pfx)) {
        sawKey = true
        if (child.kind === 'marker') continue
        const key = '/' + kp.strip(kpfx, child.key)
        if (child.kind === 'd') {
          if (dirKeys.has(key)) continue
          names.push(key)
          dirKeys.add(key)
        } else {
          names.push(key)
          sizes.set(key, child.size ?? null)
          times.set(key, child.modified ?? '')
        }
      }
      if (!sawKey && rstripSlash(rawPath) !== '') {
        // An empty directory is a zero-byte marker object keyed at the
        // prefix itself, so a prefix holding no key at all -- not even that
        // marker -- is a path the store does not have. Without this, `ls`
        // on a missing path rendered an empty directory and exited 0 where
        // every real filesystem reports ENOENT. The mount root is exempt:
        // it exists because it is mounted.
        throw await listingError(
          path,
          rawPath,
          (p) => probeFile(driver, conn, kpfx, p),
          (p) => probeDir(driver, conn, kpfx, p),
        )
      }
    } finally {
      await close()
    }
    names.sort(compareCodePoints)
    if (names.length > driver.scopeError) {
      console.warn(
        `${driver.resource} readdir: ${fullVirtualKey} returned ` +
          `${String(names.length)} entries (limit ${String(driver.scopeError)})`,
      )
    }
    const virtualEntries = names
      .map((e) => (prefix !== '' ? `${prefix}${e}` : e))
      .sort(compareCodePoints)
    if (index !== undefined) {
      const indexEntries: [string, IndexEntry][] = names.map((e) => {
        const name = e.split('/').pop() ?? ''
        if (dirKeys.has(e)) {
          // Store "folders" are synthetic prefixes with no object of their
          // own, so there is no mtime or size to record.
          return [name, new IndexEntry({ id: e, name, resourceType: ResourceType.FOLDER })]
        }
        return [
          name,
          new IndexEntry({
            id: e,
            name,
            resourceType: ResourceType.FILE,
            size: sizes.get(e) ?? null,
            remoteTime: times.get(e) ?? '',
          }),
        ]
      })
      await index.setDir(fullVirtualKey, indexEntries)
    }
    return virtualEntries
  }
}
