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

import { NO_WRITE, planFlush } from '../../handles/index.ts'
import { epochToIso } from '../../../utils/dates.ts'
import type { SetAttrFields } from '../../../types.ts'
import { BLKSIZE, LINK_MODE, SEEK_CUR, SEEK_END } from './constants.ts'
import { errnoError } from './errors.ts'
import type { MutationJournal } from './journal.ts'
import type { MirageFsSeed } from './seed.ts'
import { NodeTree } from './tree.ts'
import type {
  ErrnoCodes,
  FSAttr,
  FSHost,
  FSNode,
  FSStream,
  FSType,
  NodeOps,
  SetAttr,
  StreamOps,
} from './types.ts'

const ENC = new TextEncoder()
const S_IFMT = 0o170000
const S_IFCHR = 0o020000

// Emscripten's MEMFS makes these three at startup and its own stderr capture
// reopens /dev/stderr when a run ends (`API.restore_stderr`). Mounting mirage's
// /dev on top hid them, so that reopen raised ENOENT out of a filesystem
// callback nobody catches, and the unhandled rejection took the process down
// with it. Recreated here so the interpreter still finds them. rdev matches
// MEMFS's own numbering.
const STD_STREAM_RDEV: ReadonlyMap<string, number> = new Map([
  ['stdin', 6],
  ['stdout', 7],
  ['stderr', 8],
])

function isCharDevice(mode: number): boolean {
  return (mode & S_IFMT) === S_IFCHR
}

/**
 * The metadata a `setattr` actually changes, or null when it changes
 * none of it.
 *
 * Emscripten hands this callback more than a guest's chmod and utime:
 * a stamp arrives beside a resize and beside a mode, and a write that
 * moved no field would still journal an op. Sending one costs a
 * dispatch and, worse, splits two writes the journal would otherwise
 * coalesce. Comparing against the node costs one read.
 *
 * The one case comparing cannot catch is a create, whose finalizing
 * chmod does lower a real mode; `MirageFs.fresh` is what suppresses
 * that one.
 *
 * `ctime` is never included: no POSIX call sets it directly, so a mount
 * has nothing to write it to. `size` is not metadata here either, it is
 * the resize branch's bytes.
 *
 * Args:
 *   node: the node as it stands before the write.
 *   attr: the fields Emscripten passed, times as epoch ms.
 */
export function changedAttrs(node: FSNode, attr: SetAttr): SetAttrFields | null {
  const fields: SetAttrFields = {}
  if (attr.mode !== undefined && (attr.mode & 0o7777) !== (node.mode & 0o7777)) {
    fields.mode = attr.mode & 0o7777
  }
  if (attr.atime !== undefined && attr.atime !== node.atime) {
    fields.atime = epochToIso(attr.atime / 1000)
  }
  if (attr.mtime !== undefined && attr.mtime !== node.mtime) {
    fields.mtime = epochToIso(attr.mtime / 1000)
  }
  return Object.keys(fields).length === 0 ? null : fields
}

/**
 * An Emscripten filesystem backed by a mirage mount.
 *
 * This is the pyodide runtime's interception layer. Mounting it at a mount
 * prefix puts mirage below the guest's syscall boundary, where every
 * spelling of an operation (`open`, `os.open`, `pathlib`, `shutil`'s
 * fd-relative walk) arrives as the same callback. Nothing is patched
 * inside the interpreter.
 *
 * Callbacks are synchronous because Emscripten's are, so they never reach
 * the mounts inline: reads are served from the tree `seed` filled before
 * the run, and writes are recorded on the mutation journal for the runtime
 * to replay after it. That is the same contract the guest had before, and
 * the reason it needs no JSPI.
 *
 * The node table lives in `NodeTree` and the flush decision in
 * `planFlush`; what is left here is one method per Emscripten callback,
 * plus the errno translation only this layer performs.
 */
export class MirageFs {
  readonly type: FSType
  private readonly host: FSHost
  private readonly errno: ErrnoCodes
  private readonly journal: MutationJournal
  private readonly tree: NodeTree
  private readonly mountOf: (path: string) => string | null
  private readonly prefix: string
  // The file node FS.open just created, whose finalizing chmod is the
  // filesystem's own and not a guest metadata write. Cleared by the
  // first setattr, so it can never outlive the create it belongs to.
  private fresh: FSNode | null = null

  /**
   * Args:
   *   host: the Emscripten FS namespace (`pyodide.FS`).
   *   errno: Emscripten's errno table (`pyodide.ERRNO_CODES`).
   *   journal: the write-ahead log guest mutations are recorded on.
   *   prefix: the mount prefix this filesystem serves.
   *   mountOf: the mirage mount owning a path (`RuntimeVFS.mountOf`).
   *     One mountpoint serves every mirage mount nested under its
   *     prefix, so this is the only boundary fact left to check ops
   *     against; Emscripten's own cross-mount checks cannot see it.
   */
  constructor(
    host: FSHost,
    errno: ErrnoCodes,
    journal: MutationJournal,
    prefix: string,
    mountOf: (path: string) => string | null,
  ) {
    this.host = host
    this.prefix = prefix
    this.errno = errno
    this.journal = journal
    this.mountOf = mountOf
    const nodeOps: NodeOps = {
      getattr: this.getattr.bind(this),
      setattr: this.setattr.bind(this),
      lookup: this.lookup.bind(this),
      mknod: this.mknod.bind(this),
      rename: this.rename.bind(this),
      unlink: this.unlink.bind(this),
      rmdir: this.rmdir.bind(this),
      readdir: this.readdir.bind(this),
      symlink: this.symlink.bind(this),
      readlink: this.readlink.bind(this),
    }
    const streamOps: StreamOps = {
      open: this.streamOpen.bind(this),
      close: this.streamClose.bind(this),
      read: this.streamRead.bind(this),
      write: this.streamWrite.bind(this),
      llseek: this.llseek.bind(this),
    }
    this.tree = new NodeTree(host, prefix, nodeOps, streamOps)
    this.type = { mount: this.tree.mount.bind(this.tree) }
  }

  /**
   * Populate the tree. Must run after `FS.mount`; see `NodeTree.seed`.
   *
   * Args:
   *   seed: tree collected from the mounts before the run.
   */
  seed(seed: MirageFsSeed): void {
    // Only when this shim is what /dev resolves to. The mount's own listing
    // is untouched: these nodes live in this tree, which is what the
    // interpreter reads, not what `ls /dev` on the mount reports.
    if (this.prefix === '/dev') {
      for (const [name, rdev] of STD_STREAM_RDEV) {
        const path = `/dev/${name}`
        if (!seed.devices.has(path)) seed.charDevice(path, S_IFCHR | 0o666, rdev)
      }
    }
    this.tree.seed(seed)
  }

  private getattr(node: FSNode): FSAttr {
    // A link sizes as its target string, which is what lstat reports on
    // every POSIX system and what MEMFS answers for its own links.
    const size = this.host.isLink(node.mode)
      ? ENC.encode(node.link ?? '').length
      : this.host.isDir(node.mode)
        ? BLKSIZE
        : (node.usedBytes ?? 0)
    return {
      dev: 1,
      ino: node.id,
      mode: node.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: node.rdev,
      size,
      atime: new Date(node.atime),
      mtime: new Date(node.mtime),
      ctime: new Date(node.ctime),
      blksize: BLKSIZE,
      blocks: Math.ceil(size / BLKSIZE),
    }
  }

  private setattr(node: FSNode, attr: SetAttr): void {
    // Read the changes before applying them, and only outside a create:
    // the same callback carries a guest's chmod and the chmod Emscripten
    // itself performs to finalize a new file, and the two are the same
    // shape. `fresh` is what tells them apart; the comparison then drops
    // a stamp write that changes nothing.
    const finalizing = this.fresh === node
    this.fresh = null
    const fields = finalizing ? null : changedAttrs(node, attr)
    if (attr.mode !== undefined) node.mode = attr.mode
    if (attr.atime !== undefined) node.atime = attr.atime
    if (attr.mtime !== undefined) node.mtime = attr.mtime
    if (attr.ctime !== undefined) node.ctime = attr.ctime
    if (fields !== null) {
      // A link's own attrs go to the link, since the tree resolved to
      // the link node itself and the target's row is not what changed.
      if (this.host.isLink(node.mode)) fields.nofollow = true
      this.journal.markSetattr(this.tree.pathOf(node), fields)
    }
    if (attr.size === undefined) return
    const old = node.contents ?? new Uint8Array(0)
    const next = new Uint8Array(attr.size)
    next.set(old.subarray(0, Math.min(old.length, attr.size)))
    node.contents = next
    node.usedBytes = attr.size
    // A resize rewrites history, so it can only ship whole. Recording here
    // rather than at close is what makes a bare `os.truncate(path, n)`,
    // which opens no handle at all, reach the mount.
    this.journal.markWrite(this.tree.pathOf(node), next)
  }

  private lookup(parent: FSNode, name: string): FSNode {
    const found = this.tree.childOf(parent, name)
    // A miss is a genuine ENOENT: the seed is everything the host could
    // reach before the run, and a callback cannot await the mounts to go
    // looking for more.
    if (found === undefined) throw errnoError(this.host, this.errno, 'ENOENT')
    return found
  }

  private mknod(parent: FSNode, name: string, mode: number, rdev: number): FSNode {
    const node = this.tree.makeNode(parent, name, mode)
    node.rdev = rdev
    const path = this.tree.pathOf(node)
    // A character device is not mount content. pyodide makes one of its own
    // at runtime -- `API.capture_stderr` calls FS.createDevice, which lands
    // here as mknod -- and journaling it queued a write of /dev/capture_stderr
    // against the real mount, which then failed on replay. Devices live in
    // this tree only.
    if (isCharDevice(mode)) return node
    if (this.host.isDir(mode)) this.journal.markMkdir(path)
    else {
      // An empty write is what carries a file that is created and never
      // written (`Path.touch()`, `open(p,'w').close()`) through to the
      // mount. A later close for the same path coalesces over it.
      this.journal.markWrite(path, new Uint8Array(0))
      // FS.open finalizes a new file with a chmod of its own, right
      // here and on this node. Only a file is marked: a directory gets
      // no such call, so a marker left on one would swallow the guest's
      // next chmod instead.
      this.fresh = node
    }
    return node
  }

  private rename(node: FSNode, newDir: FSNode, newName: string): void {
    const from = this.tree.pathOf(node)
    const to = this.tree.pathOf(newDir) + '/' + newName
    // A nested mirage mount is served through this same mountpoint, so
    // Emscripten's kernel cannot see the boundary; refuse the crossing
    // here, before the tree moves and the journal records a rename the
    // post-run replay would reject anyway.
    if (this.mountOf(from) !== this.mountOf(to)) {
      throw errnoError(this.host, this.errno, 'EXDEV')
    }
    this.tree.move(node, newDir, newName)
    this.journal.markRename(from, to)
  }

  private unlink(parent: FSNode, name: string): void {
    const path = this.tree.pathOf(parent) + '/' + name
    this.tree.detach(parent, name)
    this.journal.markUnlink(path)
  }

  private rmdir(parent: FSNode, name: string): void {
    const path = this.tree.pathOf(parent) + '/' + name
    this.tree.detach(parent, name)
    this.journal.markRmdir(path)
  }

  private readdir(node: FSNode): string[] {
    return ['.', '..', ...this.tree.childNames(node)]
  }

  /**
   * Create a symlink node and record it for the mounts.
   *
   * A link is namespace state, which is exactly why this can be served:
   * the op reaches the node table rather than a backend, so a link lands
   * on an s3 or notion mount whose store has no such thing. The target
   * is stored as typed and never resolved here.
   *
   * Args:
   *   parent: directory the link is created in.
   *   name: the link's own name.
   *   target: what it points at, verbatim.
   */
  private symlink(parent: FSNode, name: string, target: string): FSNode {
    const node = this.tree.makeNode(parent, name, LINK_MODE)
    node.link = target
    this.journal.markSymlink(this.tree.pathOf(node), target)
    return node
  }

  /**
   * The target of a symlink node.
   *
   * Args:
   *   node: the node to read.
   */
  private readlink(node: FSNode): string {
    if (!this.host.isLink(node.mode)) throw errnoError(this.host, this.errno, 'EINVAL')
    return node.link ?? ''
  }

  private streamOpen(stream: FSStream): void {
    // The mount listed this file but would not serve it, so its real
    // length and content are unknown. Any handle at all is refused,
    // because a write through one could only guess at what it replaces.
    if (stream.node.unreadable === true) throw errnoError(this.host, this.errno, 'EIO')
    stream.baseLen = stream.node.usedBytes ?? 0
    stream.lowWrite = NO_WRITE
  }

  private streamClose(stream: FSStream): void {
    const low = stream.lowWrite ?? NO_WRITE
    if (low === NO_WRITE) return
    const node = stream.node
    const buf = (node.contents ?? new Uint8Array(0)).subarray(0, node.usedBytes ?? 0)
    const [kind, bytes] = planFlush(stream.baseLen ?? 0, low, buf)
    stream.lowWrite = NO_WRITE
    const path = this.tree.pathOf(node)
    if (kind === 'append') this.journal.markAppend(path, bytes)
    else this.journal.markWrite(path, bytes)
  }

  private streamRead(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const node = stream.node
    if (isCharDevice(node.mode)) {
      if (node.rdev === 0x103) return 0
      buffer.fill(0, offset, offset + length)
      return length
    }
    const used = node.usedBytes ?? 0
    if (position >= used) return 0
    const size = Math.min(used - position, length)
    buffer.set((node.contents ?? new Uint8Array(0)).subarray(position, position + size), offset)
    return size
  }

  private streamWrite(
    stream: FSStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    if (length === 0) return 0
    const node = stream.node
    if (isCharDevice(node.mode)) return length
    const need = position + length
    let contents = node.contents ?? new Uint8Array(0)
    if (contents.length < need) {
      const grown = new Uint8Array(need)
      grown.set(contents)
      contents = grown
      node.contents = grown
    }
    contents.set(buffer.subarray(offset, offset + length), position)
    node.usedBytes = Math.max(node.usedBytes ?? 0, need)
    node.mtime = node.ctime = Date.now()
    stream.lowWrite = Math.min(stream.lowWrite ?? NO_WRITE, position)
    return length
  }

  private llseek(stream: FSStream, offset: number, whence: number): number {
    let position = offset
    if (whence === SEEK_CUR) position += stream.position
    else if (whence === SEEK_END && this.host.isFile(stream.node.mode)) {
      position += stream.node.usedBytes ?? 0
    }
    if (position < 0) throw errnoError(this.host, this.errno, 'EINVAL')
    return position
  }
}
