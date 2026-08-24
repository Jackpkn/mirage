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

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

import { prepareNfsMount } from './backend.ts'
import { NFSConfig } from './config.ts'
import { nfsErrno } from './errors.ts'
import { MirageNFS } from './fs.ts'
import type { DirEntry, NFSAttrs } from './types.ts'

const run = promisify(execFile)

export const MOUNT_TIMEOUT_SECONDS = 10
const POLL_SECONDS = 0.05

/** The npm package carrying the prebuilt addon (`mirage-nfs-node`). */
export const ADDON_PACKAGE = '@struktoai/mirage-nfs-node'
/** Points the loader at a locally built `.node`, for development and integ. */
export const ADDON_ENV = 'MIRAGE_NFS_ADDON'

const requireAddon = createRequire(import.meta.url)

// ── The addon's wire shapes ──────────────────────────────────────────
// One interface per `#[napi(object)]` in `mirage-nfs/src/bridge.rs`, in
// its field order. A reply carries `errno` instead of throwing, because
// an exception cannot cross into rust: the addon reads the number and
// maps it onto an nfsstat3.

export interface NameArgs {
  dirId: number
  name: string
}

export interface IdArgs {
  id: number
}

export interface ReadArgs {
  id: number
  offset: number
  count: number
}

export interface WriteArgs {
  id: number
  offset: number
  data: Buffer
}

export interface SetSizeArgs {
  id: number
  size?: number | null
}

export interface RenameArgs {
  fromDirId: number
  fromName: string
  toDirId: number
  toName: string
}

export interface SymlinkArgs {
  dirId: number
  name: string
  target: string
}

export interface ReaddirArgs {
  dirId: number
  startAfter: number
  maxEntries: number
}

/**
 * `Attrs` from bridge.rs. Only `errno`, `mode` and `mtimeEpoch` are
 * `Option` there, so a failure reply still has to carry the other four
 * fields or the rust side cannot deserialize it at all and the client
 * sees SERVERFAULT in place of the real condition.
 */
export type AttrsReply = NFSAttrs & { errno?: number }

export interface IdReply {
  errno?: number
  fileid?: number
}

export interface BytesReply {
  errno?: number
  data?: Buffer
}

export interface TextReply {
  errno?: number
  text?: string
}

export interface UnitReply {
  errno?: number
}

export interface EntriesReply {
  errno?: number
  entries?: { name: string; attrs: AttrsReply }[]
}

/** The thirteen callbacks `start()` takes, in its argument order. */
export interface NFSDelegate {
  lookup: (args: NameArgs) => Promise<IdReply>
  getattr: (args: IdArgs) => Promise<AttrsReply>
  setSize: (args: SetSizeArgs) => Promise<AttrsReply>
  read: (args: ReadArgs) => Promise<BytesReply>
  write: (args: WriteArgs) => Promise<AttrsReply>
  create: (args: NameArgs) => Promise<IdReply>
  mkdir: (args: NameArgs) => Promise<IdReply>
  remove: (args: NameArgs) => Promise<UnitReply>
  rename: (args: RenameArgs) => Promise<UnitReply>
  symlink: (args: SymlinkArgs) => Promise<IdReply>
  readlink: (args: IdArgs) => Promise<TextReply>
  readdir: (args: ReaddirArgs) => Promise<EntriesReply>
  flushIdle: (args: IdArgs) => Promise<UnitReply>
}

/** The adapter surface `buildDelegate` marshals; `MirageNFS` implements it. */
export interface NFSDelegateTarget {
  lookup: (dirid: number, name: string) => Promise<number>
  getattr: (fileid: number) => Promise<NFSAttrs>
  setSize: (fileid: number, size: number | null) => Promise<NFSAttrs>
  read: (fileid: number, offset: number, count: number) => Promise<Buffer>
  write: (fileid: number, offset: number, data: Buffer) => Promise<NFSAttrs>
  create: (dirid: number, name: string) => Promise<number>
  mkdir: (dirid: number, name: string) => Promise<number>
  remove: (dirid: number, name: string) => Promise<void>
  rename: (fromDirid: number, fromName: string, toDirid: number, toName: string) => Promise<void>
  symlink: (dirid: number, name: string, target: string) => Promise<number>
  readlink: (fileid: number) => Promise<string>
  readdir: (dirid: number, cookie: number, maxEntries: number) => Promise<DirEntry[]>
  flushIdle: () => Promise<void>
}

/** A running server. `NfsServerHandle` in `mirage-nfs/src/lib.rs`. */
export interface NFSServerHandle {
  port: () => number
  stop: () => void
}

export interface NFSAddon {
  start: (
    lookup: NFSDelegate['lookup'],
    getattr: NFSDelegate['getattr'],
    setSize: NFSDelegate['setSize'],
    read: NFSDelegate['read'],
    write: NFSDelegate['write'],
    create: NFSDelegate['create'],
    mkdir: NFSDelegate['mkdir'],
    remove: NFSDelegate['remove'],
    rename: NFSDelegate['rename'],
    symlink: NFSDelegate['symlink'],
    readlink: NFSDelegate['readlink'],
    readdir: NFSDelegate['readdir'],
    flushIdle: NFSDelegate['flushIdle'],
    host: string,
    port: number,
    rootId: number,
    uid: number,
    gid: number,
    idleSeconds: number,
  ) => Promise<NFSServerHandle>
}

/**
 * Load the addon, naming the install when it is absent.
 *
 * The addon is optional the way FUSE's driver is: importing mirage never
 * requires it, and the error names what to install rather than leaking a
 * resolution failure from inside a mount call. It is loaded through
 * `createRequire` because a `.node` binding is CommonJS whichever name
 * reaches it, and because that is the only form the `ADDON_ENV` override
 * (an absolute path to a local build) can take.
 */
export function loadAddon(): NFSAddon {
  const override = process.env[ADDON_ENV]
  const specifier =
    override === undefined || override === '' ? ADDON_PACKAGE : resolvePath(override)
  try {
    const loaded: unknown = requireAddon(specifier)
    return loaded as NFSAddon
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `the nfs mount backend needs the ${ADDON_PACKAGE} addon; install it with: ` +
        `npm install ${ADDON_PACKAGE}, or point ${ADDON_ENV} at a local build ` +
        `(${reason})`,
    )
  }
}

/**
 * Wrap one adapter as the thirteen callbacks the addon calls back into.
 *
 * There is no python twin: PyO3 calls methods on the delegate object
 * itself, so its classification lives in rust. napi takes plain
 * functions, and no exception may cross the boundary, so each wrapper
 * catches and answers with an errno reply instead — the one place that
 * translation happens.
 */
export function buildDelegate(fs: NFSDelegateTarget): NFSDelegate {
  return {
    lookup: async ({ dirId, name }) => idReply(() => fs.lookup(dirId, name)),
    getattr: async ({ id }) => attrsReply(id, () => fs.getattr(id)),
    setSize: async ({ id, size }) => attrsReply(id, () => fs.setSize(id, size ?? null)),
    read: async ({ id, offset, count }) => {
      try {
        return { data: await fs.read(id, offset, count) }
      } catch (err) {
        return { errno: nfsErrno(err) }
      }
    },
    write: async ({ id, offset, data }) => attrsReply(id, () => fs.write(id, offset, data)),
    create: async ({ dirId, name }) => idReply(() => fs.create(dirId, name)),
    mkdir: async ({ dirId, name }) => idReply(() => fs.mkdir(dirId, name)),
    remove: async ({ dirId, name }) => unitReply(() => fs.remove(dirId, name)),
    rename: async ({ fromDirId, fromName, toDirId, toName }) =>
      unitReply(() => fs.rename(fromDirId, fromName, toDirId, toName)),
    symlink: async ({ dirId, name, target }) => idReply(() => fs.symlink(dirId, name, target)),
    readlink: async ({ id }) => {
      try {
        return { text: await fs.readlink(id) }
      } catch (err) {
        return { errno: nfsErrno(err) }
      }
    },
    readdir: async ({ dirId, startAfter, maxEntries }) => {
      try {
        const entries = await fs.readdir(dirId, startAfter, maxEntries)
        // DirEntryOut is { name, attrs }: vfs.rs reads the id off
        // attrs.fileid, so the cookie never travels as its own field.
        return { entries: entries.map(({ name, attrs }) => ({ name, attrs })) }
      } catch (err) {
        return { errno: nfsErrno(err) }
      }
    },
    flushIdle: async () => unitReply(() => fs.flushIdle()),
  }
}

async function idReply(call: () => Promise<number>): Promise<IdReply> {
  try {
    return { fileid: await call() }
  } catch (err) {
    return { errno: nfsErrno(err) }
  }
}

async function unitReply(call: () => Promise<void>): Promise<UnitReply> {
  try {
    await call()
    return {}
  } catch (err) {
    return { errno: nfsErrno(err) }
  }
}

async function attrsReply(fileid: number, call: () => Promise<NFSAttrs>): Promise<AttrsReply> {
  try {
    return await call()
  } catch (err) {
    return { errno: nfsErrno(err), fileid, size: 0, isDir: false, isSymlink: false }
  }
}

/**
 * The kernel mount command for one export.
 *
 * `port=mountport=<port>` keeps portmap (111) and NLM out of the picture
 * entirely; `actimeo=0` keeps client attribute caches fresh, the
 * analogue of the FUSE mounts' `attr_timeout=0`.
 */
export function mountArgs(
  mountpoint: string,
  port: number,
  exportPath: string,
  platform: string = process.platform,
): [string, ...string[]] {
  const source = `127.0.0.1:${exportPath}`
  if (platform === 'darwin') {
    const port_ = String(port)
    const opts = `nolocks,vers=3,tcp,rsize=131072,actimeo=0,port=${port_},mountport=${port_}`
    return ['mount_nfs', '-o', opts, source, mountpoint]
  }
  const bare = String(port)
  const opts = `nolock,vers=3,tcp,rsize=131072,actimeo=0,port=${bare},mountport=${bare}`
  return ['mount', '-t', 'nfs', '-o', opts, source, mountpoint]
}

/**
 * The unmount command for a mountpoint.
 *
 * Plain `umount` everywhere; `runUmount` falls back to
 * `diskutil unmount force` on a darwin refusal.
 */
export function umountArgs(
  mountpoint: string,
  _platform: string = process.platform,
): [string, ...string[]] {
  return ['umount', mountpoint]
}

/** Resolve the mountpoint, creating a temporary one when unnamed. */
export function prepareMountpoint(mountpoint?: string): [string, boolean] {
  if (mountpoint !== undefined && mountpoint !== '') {
    mkdirSync(mountpoint, { recursive: true })
    return [mountpoint, false]
  }
  return [mkdtempSync(join(tmpdir(), 'mirage-nfs-')), true]
}

/**
 * Whether the kernel has a filesystem mounted at `path`.
 *
 * `os.path.ismount`'s rule, which is the readiness signal the FSKit
 * lesson demands: a mountpoint directory existing is not a mount. It is
 * CPython's `genericpath.ismount` line for line — lstat both sides, a
 * symlink is never a mount, the parent is reached as `path/..` (so a
 * relative path works, where `dirname` would answer the empty string),
 * a differing device means a boundary and a shared inode means a root.
 *
 * Both stats are async on purpose: over NFS the stat is served by this
 * very event loop, and a synchronous one would block the loop that has
 * to answer it.
 */
export async function isMountPoint(path: string): Promise<boolean> {
  try {
    const self = await lstat(path)
    if (self.isSymbolicLink()) return false
    const parent = await lstat(join(path, '..'))
    return self.dev !== parent.dev || self.ino === parent.ino
  } catch {
    // the path is gone or unreadable: not a live mount either way
    return false
  }
}

/** Wait until the kernel reports a live mount, or fail loudly. */
export async function awaitIsMount(
  mountpoint: string,
  timeout: number = MOUNT_TIMEOUT_SECONDS,
  probe: (path: string) => Promise<boolean> = isMountPoint,
): Promise<void> {
  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    if (await probe(mountpoint)) return
    await new Promise((wake) => setTimeout(wake, POLL_SECONDS * 1000))
  }
  throw new Error(
    `nfs mount at ${JSON.stringify(mountpoint)} did not come up within ${String(timeout)}s`,
  )
}

/** Run the kernel mount command and wait for the mount to be live. */
export async function runMount(
  mountpoint: string,
  port: number,
  exportPath: string,
): Promise<void> {
  const [program, ...argv] = mountArgs(mountpoint, port, exportPath)
  try {
    await run(program, argv)
  } catch (err) {
    const failure = err as { code?: number | string; stdout?: string; stderr?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    const reason = output === '' ? String(err) : output
    throw new Error(`${program} failed (${String(failure.code ?? 1)}): ${reason}`)
  }
  await awaitIsMount(mountpoint)
}

/** Unmount, falling back to diskutil force on a darwin refusal. */
export async function runUmount(mountpoint: string): Promise<void> {
  const [program, ...argv] = umountArgs(mountpoint)
  try {
    await run(program, argv)
    return
  } catch {
    // busy or already gone; darwin gets one forced attempt below
  }
  if (process.platform === 'darwin') {
    try {
      await run('diskutil', ['unmount', 'force', mountpoint])
    } catch {
      // best effort: the caller already tried the clean path
    }
  }
}

/**
 * Run the mount guards and start the NFS server for one workspace.
 *
 * The delegate runs on this process's event loop, so the FUSE
 * self-touch rule applies verbatim: never touch the mountpoint
 * synchronously from here, or the call blocks the loop that must answer
 * it.
 *
 * Known limitation of the current addon: the idle-flush task holds its
 * callback for the process's lifetime, so `stop()` ends the exports but
 * does not release node's event loop. A script that mounts and closes
 * still has to `process.exit()`.
 */
export async function startServer(
  ws: Workspace,
  config: NFSConfig = new NFSConfig(),
): Promise<[MirageNFS, NFSServerHandle]> {
  await prepareNfsMount('nfs', ws, config)
  const addon = loadAddon()
  const fs = new MirageNFS(ws.fs, config)
  const delegate = buildDelegate(fs)
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  const handle = await addon.start(
    delegate.lookup,
    delegate.getattr,
    delegate.setSize,
    delegate.read,
    delegate.write,
    delegate.create,
    delegate.mkdir,
    delegate.remove,
    delegate.rename,
    delegate.symlink,
    delegate.readlink,
    delegate.readdir,
    delegate.flushIdle,
    config.host,
    config.port,
    fs.rootDir(),
    uid,
    gid,
    config.idleFlushSeconds,
  )
  return [fs, handle]
}
