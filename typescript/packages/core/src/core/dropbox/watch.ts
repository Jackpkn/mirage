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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import type { PathSpec, WalkEntry } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { ListingDeltaHook } from '../../watch/delta.ts'
import { statFingerprint } from '../../watch/fingerprint.ts'
import { DropboxApiError } from './_client.ts'
import { listFolder } from './api.ts'
import { dropboxPathOf } from './paths.ts'

/**
 * One recursive `list_folder` feeding the generic listing differ.
 *
 * Reads the account directly, never through mirage's caches, as the DeltaHook
 * contract requires.
 *
 * Fingerprints on `content_hash`, Dropbox's own content digest, so an upload of
 * identical bytes is correctly reported as no change; `rev` is the fallback,
 * and it moves on any write.
 *
 * Dropbox also offers a cursor: the same endpoint returns one, and
 * `list_folder/continue` replays only what changed since. That is a faster
 * pull, not a more correct one, and it cannot replace this walk, because the
 * server may invalidate a cursor at any time and the only answer to that is a
 * full listing. When the fast path is added it belongs behind `pull`, with this
 * walk as its reset path.
 */
export class DropboxWalk {
  private readonly accessor: DropboxAccessor

  constructor(accessor: DropboxAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const accessor = this.accessor
    const prefix = mountPrefixOf(root.virtual, root.resourcePath)
    const apiRoot = dropboxPathOf(accessor, root)
    let found
    try {
      found = await listFolder(accessor.tokenManager, apiRoot, { recursive: true })
    } catch (error) {
      // list_folder 409s on a missing path and on a file operand;
      // either way there is nothing under this root to report.
      if (error instanceof DropboxApiError && error.status === 409) return
      throw error
    }
    // Dropbox paths are case-insensitive: `path_display` carries the
    // server's casing while `rootPath` carries the user's, so a configured
    // `/team` whose displayed path is `/Team` matched nothing and every
    // event landed outside the watch scope. The comparison folds case; the
    // slice keeps the server's casing for everything below the root, and is
    // safe because `path_lower` is `path_display` lowercased, same length.
    const base = accessor.rootPath
    const folded = base.toLowerCase()
    for (const entry of found) {
      const display = entry.path_display ?? entry.path_lower
      if (display === undefined || display === '') continue
      const trimmed =
        base !== '' && display.toLowerCase().startsWith(folded)
          ? display.slice(base.length)
          : display
      const relative = stripSlash(trimmed)
      if (relative === '') continue
      const virtual = prefix !== '' ? `${prefix}/${relative}` : `/${relative}`
      if (entry['.tag'] === 'folder') {
        yield { virtual, isDir: true, fingerprint: null }
        continue
      }
      const modified = entry.server_modified ?? entry.client_modified ?? null
      const size = typeof entry.size === 'number' ? entry.size : null
      const version = entry.content_hash ?? entry.rev ?? null
      yield {
        virtual,
        isDir: false,
        fingerprint: statFingerprint(version, modified, size),
        size,
        modified,
      }
    }
  }
}

export function buildDeltaHook(accessor: DropboxAccessor): DeltaHook {
  const walk = new DropboxWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}
