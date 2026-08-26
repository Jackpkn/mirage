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

import { posix } from 'node:path'

import type { Ops } from '@struktoai/mirage-core/ops/ops'
import { FileType } from '@struktoai/mirage-core/types'
import { mtimeMs } from '@struktoai/mirage-core/utils/stat_view'
import type { FileStat } from '@struktoai/mirage-core/types'
import { sortedByCodePoints } from '@struktoai/mirage-core/utils/sort'

import { errnoError } from '../mount/errors.ts'
import { isMacosMetadata } from '../mount/platform/macos.ts'
import { NFSConfig } from './config.ts'
import { StaleHandleError } from './errors.ts'
import { IdTable, ROOT_PATH } from './ids.ts'
import type { DirEntry, NFSAttrs } from './types.ts'
import { WriteBuffer } from './writebuf.ts'

function joinPath(parent: string, name: string): string {
  return parent === ROOT_PATH ? ROOT_PATH + name : posix.join(parent, name)
}

function enoent(path: string): Error {
  return errnoError('ENOENT', `no such file or directory: ${path}`)
}

function einval(path: string): Error {
  return errnoError('EINVAL', `invalid argument: ${path}`)
}

/**
 * The NFSv3 filesystem the server crate calls back into.
 *
 * One method per trait callback, each one async so it runs on the
 * event loop and reaches the op door the same way a shell command
 * does: mount grants, admission policies, cache and namespace all
 * fire once, at that door. The adapter itself owns only what the
 * protocol needs and mirage does not have -- which file id names
 * which path, and the writes a client has sent but not yet had
 * stored.
 *
 * Paths crossing this boundary are mount-relative; the mount prefix
 * is applied by the op facade this is constructed with.
 */
export class MirageNFS {
  private readonly ops: Ops
  private readonly config: NFSConfig
  private readonly ids = new IdTable()
  private readonly writes = new WriteBuffer()
  // One chain per file that has been written, cleared with the buffer it
  // guards, so the map tracks live files rather than every id minted.
  private readonly flushChains = new Map<number, Promise<void>>()
  private readonly root: number

  constructor(ops: Ops, config: NFSConfig = new NFSConfig()) {
    this.ops = ops
    this.config = config
    this.root = this.ids.alloc(ROOT_PATH)
  }

  /** The file id of the export root. */
  rootDir(): number {
    return this.root
  }

  /** Resolve a name inside a directory to a file id. */
  async lookup(dirid: number, name: string): Promise<number> {
    if (isMacosMetadata(name)) {
      // Finder and Spotlight probe these on every listing; answering
      // here keeps the probe off the backend, as MountCore does.
      throw enoent(name)
    }
    const path = joinPath(this.ids.resolve(dirid), name)
    if (this.linkTarget(path) === null) await this.ops.stat(path)
    return this.ids.alloc(path)
  }

  /** Attributes for a file id, counting writes not yet stored. */
  async getattr(fileid: number): Promise<NFSAttrs> {
    return this.entryAttrs(fileid, this.ids.resolve(fileid))
  }

  /** Read through any writes still buffered for this file. */
  async read(fileid: number, offset: number, count: number): Promise<Buffer> {
    const path = this.ids.resolve(fileid)
    const base = await this.readBase(path)
    return this.writes.overlay(fileid, base, offset, count)
  }

  /**
   * Buffer a write and answer with the size the client expects.
   *
   * The bytes are stored on flush, not here: this server answers
   * every write as durable and never forwards a COMMIT, so the
   * adapter batches and bounds the window itself.
   */
  async write(fileid: number, offset: number, data: Buffer): Promise<NFSAttrs> {
    const path = this.ids.resolve(fileid)
    const full = this.writes.append(fileid, offset, data, this.config.maxBufferedBytes)
    if (full) await this.flushOne(fileid, path)
    return this.entryAttrs(fileid, path)
  }

  /** Create an empty file and return its id. */
  async create(dirid: number, name: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), name)
    await this.ops.create(path)
    return this.ids.alloc(path)
  }

  /** Create a directory and return its id. */
  async mkdir(dirid: number, name: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), name)
    await this.ops.mkdir(path)
    return this.ids.alloc(path)
  }

  /**
   * Remove a file or directory.
   *
   * The server routes both REMOVE and RMDIR here, so the entry is
   * stat-ed first to pick the right op. A link is unlinked whatever
   * it points at: stat would follow it, and following a link to a
   * directory would rmdir the target instead of the link. Buffered
   * writes are dropped rather than flushed -- storing them would
   * bring the file back.
   */
  async remove(dirid: number, name: string): Promise<void> {
    const path = joinPath(this.ids.resolve(dirid), name)
    const fileid = this.ids.idFor(path)
    if (this.linkTarget(path) !== null) {
      if (fileid !== undefined) this.dropBuffered(fileid)
      await this.ops.unlink(path)
      if (fileid !== undefined) this.ids.invalidate(fileid)
      return
    }
    const stat = await this.ops.stat(path)
    if (fileid !== undefined) this.dropBuffered(fileid)
    if (stat.type === FileType.DIRECTORY) {
      await this.ops.rmdir(path)
    } else {
      await this.ops.unlink(path)
    }
    if (fileid !== undefined) this.ids.invalidate(fileid)
  }

  /**
   * Move an entry, carrying its id and pending writes with it.
   *
   * Pending writes are flushed to the old path first: they were
   * acknowledged against it, and flushing after the move would merge
   * them onto whatever now lives at the destination.
   */
  async rename(
    fromDirid: number,
    fromName: string,
    toDirid: number,
    toName: string,
  ): Promise<void> {
    const src = joinPath(this.ids.resolve(fromDirid), fromName)
    const dst = joinPath(this.ids.resolve(toDirid), toName)
    this.ids.guardRename(src, dst)
    const fileid = this.ids.idFor(src)
    if (fileid !== undefined && this.writes.hasPending(fileid)) {
      await this.flushOne(fileid, src)
    }
    await this.ops.rename(src, dst)
    this.ids.rename(src, dst)
  }

  /**
   * Apply the one settable attribute: size.
   *
   * mode, uid, gid and the timestamps are accepted and discarded,
   * exactly as the FUSE adapter does -- a mirage backend has nowhere
   * to persist them, and refusing would fail ordinary tools.
   */
  async setSize(fileid: number, size: number | null): Promise<NFSAttrs> {
    const path = this.ids.resolve(fileid)
    if (size !== null) {
      this.writes.clip(fileid, size)
      await this.ops.truncate(path, size)
    }
    return this.entryAttrs(fileid, path)
  }

  /** Create a symlink and return its id. */
  async symlink(dirid: number, name: string, target: string): Promise<number> {
    const path = joinPath(this.ids.resolve(dirid), name)
    await this.ops.symlink(path, target)
    return this.ids.alloc(path)
  }

  /**
   * The target a symlink holds, as the client should see it.
   *
   * Relative targets are returned verbatim; absolute ones name
   * virtual paths and are rewritten relative to the link's directory,
   * since a client would otherwise resolve them against its own root
   * and escape the mount.
   */
  // A link is namespace state, so this reads no backend; the callback
  // contract is still one async method per NFS procedure.
  // eslint-disable-next-line @typescript-eslint/require-await
  async readlink(fileid: number): Promise<string> {
    const path = this.ids.resolve(fileid)
    const target = this.linkTarget(path)
    if (target === null) throw einval(path)
    return target
  }

  /**
   * List a directory, resuming after the entry `cookie` names.
   *
   * The cookie is the last-seen entry's fileid: the server crate
   * derives the wire cookie from each entry's id and hands it back as
   * `startAfter`. Resume keys on identity, never on comparing
   * magnitudes -- ids are minted in access order, so a later entry
   * may carry a smaller id than an earlier one.
   */
  async readdir(dirid: number, cookie = 0, maxEntries?: number): Promise<DirEntry[]> {
    const path = this.ids.resolve(dirid)
    // The facade answers in paths -- a child mount with a trailing
    // slash -- so names are derived the way MountCore.readdir does,
    // and macOS metadata names are dropped the same way.
    const found = new Set<string>()
    for (const entry of await this.ops.readdir(path)) {
      const part = entry.replace(/\/+$/, '').split('/').pop() ?? ''
      if (part !== '' && !isMacosMetadata(part)) found.add(part)
    }
    const entries: DirEntry[] = []
    let resuming = cookie !== 0
    for (const name of sortedByCodePoints(found)) {
      const child = joinPath(path, name)
      const fileid = this.ids.alloc(child)
      if (resuming) {
        if (fileid === cookie) resuming = false
        continue
      }
      entries.push({
        name,
        fileid,
        cookie: fileid,
        attrs: await this.entryAttrs(fileid, child),
      })
      if (maxEntries !== undefined && entries.length >= maxEntries) break
    }
    return entries
  }

  /** Store one file's buffered writes. */
  async flush(fileid: number): Promise<void> {
    if (this.writes.hasPending(fileid)) {
      await this.flushOne(fileid, this.ids.resolve(fileid))
    }
  }

  /**
   * Store every buffered write. Used at teardown. A file id that went
   * stale under a pending buffer is dropped rather than raised: one
   * dead entry must not stop the rest from being stored.
   */
  async flushAll(): Promise<void> {
    for (const fileid of this.writes.pendingIds()) await this.flushOrDrop(fileid)
  }

  /** Store writes untouched for longer than the idle window. */
  async flushIdle(): Promise<void> {
    for (const fileid of this.writes.idleIds(this.config.idleFlushSeconds)) {
      await this.flushOrDrop(fileid)
    }
  }

  private async flushOrDrop(fileid: number): Promise<void> {
    let path: string
    try {
      path = this.ids.resolve(fileid)
    } catch (err) {
      if (!(err instanceof StaleHandleError)) throw err
      this.writes.drop(fileid)
      this.flushChains.delete(fileid)
      return
    }
    await this.flushOne(fileid, path)
  }

  /**
   * Store one file's buffered writes, one flush at a time.
   *
   * Read, take and store are one critical section. Without it two
   * flushes of the same file -- an idle timer against a size trigger,
   * or either against teardown -- each read the same stored base and
   * take different batches, and whichever store settles last drops the
   * other batch. The client was told those bytes were durable.
   *
   * Serialized by chaining rather than a lock, which JavaScript has no
   * need of: the chain is the queue, and a failed flush does not strand
   * the ones behind it.
   */
  /** Forget a file's pending writes and the chain that serialized them. */
  private dropBuffered(fileid: number): void {
    this.writes.drop(fileid)
    this.flushChains.delete(fileid)
  }

  private async flushOne(fileid: number, path: string): Promise<void> {
    const previous = this.flushChains.get(fileid) ?? Promise.resolve()
    const mine = previous.catch(() => undefined).then(() => this.storeOne(fileid, path))
    this.flushChains.set(fileid, mine)
    try {
      await mine
    } finally {
      // Only the tail clears itself: an earlier link finishing must not
      // drop a chain a later flush is still queued behind.
      if (this.flushChains.get(fileid) === mine) this.flushChains.delete(fileid)
    }
  }

  private async storeOne(fileid: number, path: string): Promise<void> {
    const base = await this.readBase(path)
    const pending = this.writes.take(fileid)
    if (pending.length === 0) return
    await this.ops.writeFile(path, WriteBuffer.merge(base, pending))
  }

  private async readBase(path: string): Promise<Buffer> {
    try {
      return Buffer.from(await this.ops.readFile(path, { raw: true }))
    } catch {
      // missing file or a directory: the write starts from empty
      return Buffer.alloc(0)
    }
  }

  /**
   * The target to present for a namespace link, null otherwise.
   *
   * The link check must precede any ops stat, exactly as in
   * MountCore.getattr: the op facade follows namespace links, so a
   * stat on a link path reports the target and the link itself
   * becomes invisible.
   */
  private linkTarget(path: string): string | null {
    const links = this.ops.links
    if (links === null) return null
    const target = links.readlink(path)
    if (target === null) return null
    if (!target.startsWith('/')) return target
    const parent = path.split('/').slice(0, -1).join('/') || '/'
    return posix.relative(parent, target)
  }

  /** Attributes for one entry, seeing a link as itself. */
  private async entryAttrs(fileid: number, path: string): Promise<NFSAttrs> {
    const target = this.linkTarget(path)
    if (target !== null) {
      return {
        fileid,
        size: Buffer.byteLength(target),
        isDir: false,
        isSymlink: true,
      }
    }
    return this.attrs(fileid, await this.ops.stat(path))
  }

  private attrs(fileid: number, stat: FileStat): NFSAttrs {
    const isDir = stat.type === FileType.DIRECTORY
    const size = isDir ? 0 : this.writes.pendingSize(fileid, stat.size ?? 0)
    const out: NFSAttrs = {
      fileid,
      size,
      isDir,
      isSymlink: stat.type === FileType.SYMLINK,
    }
    if (stat.mode !== null) out.mode = stat.mode
    // The wire needs an nfstime3 and vfs.rs reads exactly this field; a
    // row with no time leaves it unset, and the client reads 1970, which
    // is honest where a fabricated "now" would not be.
    const ms = mtimeMs(stat)
    if (ms !== null) out.mtimeEpoch = ms / 1000
    return out
  }
}
