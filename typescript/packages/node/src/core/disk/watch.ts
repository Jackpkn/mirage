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

import {
  FileChangeKind,
  type FileEvent,
  type JsonValue,
  type PathSpec,
  type WalkEntry,
} from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  type DeltaHook,
  eventAt,
  type EventHook,
  ListingDeltaHook,
  statFingerprint,
  textField,
} from '@struktoai/mirage-core/watch/index'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { resolveSafe } from './utils.ts'

async function* descend(root: string, full: string): AsyncGenerator<WalkEntry> {
  let listing
  try {
    listing = await readdir(full, { withFileTypes: true })
  } catch (error) {
    // Absence is the one error a walk may swallow: the directory went
    // away between the parent listing and this one, and the next pull
    // reports the DELETE from the snapshot diff. Anything else (EACCES,
    // EIO) means the subtree is unreadable, not empty, and returning
    // here would diff a partial listing into a DELETE for every child
    // plus a CREATE for each when access came back. Aborting the pull
    // keeps the prior checkpoint, which is what IncompleteWalkError
    // exists to protect.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  for (const entry of listing) {
    const child = path.join(full, entry.name)
    const virtual = '/' + path.relative(root, child).split(path.sep).join('/')
    if (entry.isDirectory()) {
      yield { virtual, isDir: true, fingerprint: null }
      yield* descend(root, child)
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = await lstat(child)
    } catch (error) {
      // Same rule one entry down: a vanished file is a DELETE the next
      // pull reports, an unreadable one is not.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    const modified = info.mtime.toISOString()
    yield {
      virtual,
      isDir: false,
      fingerprint: statFingerprint(null, modified, info.size),
      size: info.size,
      modified,
    }
  }
}

/**
 * Recursive directory walk feeding the generic listing differ.
 *
 * Reads the filesystem directly, never through mirage's caches, as the
 * DeltaHook contract requires. Fingerprints on mtime, the same value `disk`
 * stat reports, so an editor that rewrites identical bytes still registers as
 * an UPDATE. That is the local filesystem's own resolution, not a mirage
 * choice: nothing cheaper than hashing every file can tell those two apart.
 *
 * Symlinks are not followed, matching every other disk walk in the repo and
 * keeping a link loop from hanging the poll.
 */
export class DiskWalk {
  private readonly accessor: DiskAccessor

  constructor(accessor: DiskAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.resourcePath)
    const start = resolveSafe(this.accessor.root, root.mountPath)
    for await (const entry of descend(this.accessor.root, start)) {
      yield {
        ...entry,
        virtual: prefix !== '' ? `${prefix}${entry.virtual}` : entry.virtual,
      }
    }
  }
}

export function buildDeltaHook(accessor: DiskAccessor): DeltaHook {
  const walk = new DiskWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}

const DISK_KINDS: Record<string, FileChangeKind> = {
  created: FileChangeKind.CREATE,
  modified: FileChangeKind.UPDATE,
  deleted: FileChangeKind.DELETE,
}

/**
 * Map one local filesystem notification onto mount paths.
 *
 * Mirage runs no watcher of its own: the consumer owns the inotify / FSEvents
 * / ReadDirectoryChangesW loop (chokidar, `fs.watch`, or the raw syscall) and
 * forwards what it saw, which keeps the dependency out of the package and lets
 * a deployment pick its own mechanism.
 *
 * `eventType` is one of `created`, `modified`, `deleted` or `moved`, so a
 * consumer translates its library's spelling once (chokidar's `add`/`addDir`
 * are `created`, `unlink`/`unlinkDir` are `deleted`, `change` is `modified`).
 * Any other name maps to nothing, because a watcher reports events this mount
 * has no opinion about.
 *
 * `payload` carries the host absolute paths the event named:
 * `{path, dest_path, is_directory}`, matching watchdog's field names so the
 * two languages take the same body.
 *
 * Mirrors Python `DiskEventHook` (`core/disk/watch.py`).
 */
export class DiskEventHook {
  private readonly accessor: DiskAccessor

  constructor(accessor: DiskAccessor) {
    this.accessor = accessor
  }

  /**
   * Mount-relative form of a host path, or null if outside the mount.
   *
   * A watcher may be rooted above the mount, so an event for a sibling
   * directory is not this mount's to report.
   */
  private relative(hostPath: string): string | null {
    const root = path.resolve(this.accessor.root)
    const resolved = path.resolve(hostPath)
    if (resolved === root) return '/'
    if (!resolved.startsWith(root + path.sep)) return null
    return (
      '/' +
      resolved
        .slice(root.length + 1)
        .split(path.sep)
        .join('/')
    )
  }

  /**
   * Map one filesystem notification to the change it implies.
   *
   * A directory's own `modified` stays an UPDATE rather than becoming UNKNOWN:
   * inotify raises it whenever a child appears or vanishes, and it also
   * delivers that child's own event, so re-inventorying the subtree on every
   * write inside a directory would throw away the whole cache for nothing.
   */
  toEvents(root: PathSpec, eventType: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    const source = textField(payload, 'path')
    if (source === undefined) return Promise.resolve([])
    const relative = this.relative(source)
    if (relative === null) return Promise.resolve([])
    if (eventType === 'moved') {
      const target = textField(payload, 'dest_path')
      const movedTo = target === undefined ? null : this.relative(target)
      if (movedTo === null) {
        return Promise.resolve([eventAt(root, relative, FileChangeKind.DELETE)])
      }
      return Promise.resolve([eventAt(root, movedTo, FileChangeKind.MOVE, relative)])
    }
    const kind = DISK_KINDS[eventType]
    if (kind === undefined) return Promise.resolve([])
    return Promise.resolve([eventAt(root, relative, kind)])
  }
}

export function buildEventHook(accessor: DiskAccessor): EventHook {
  return new DiskEventHook(accessor)
}
