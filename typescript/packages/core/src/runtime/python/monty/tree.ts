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

import type { OpenMode } from '../../handles/mode.ts'

interface FileNode {
  content: string | Uint8Array
}

type DirNode = Map<string, TreeNode>
type TreeNode = FileNode | DirNode

function isDir(node: TreeNode | null): node is DirNode {
  return node instanceof Map
}

function isFile(node: TreeNode | null): node is FileNode {
  return node !== null && !(node instanceof Map)
}

/**
 * A guest path's parts, the way PurePosixPath spells them: a leading
 * '/' is its own first part, empty and '.' segments vanish, '..' stays
 * (the tree resolves no dots, exactly like monty's own).
 */
function parts(path: string): string[] {
  const out: string[] = []
  if (path.startsWith('/')) out.push('/')
  for (const seg of path.split('/')) {
    if (seg !== '' && seg !== '.') out.push(seg)
  }
  return out
}

function treeError(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

/** A parts() segment by index from the end; guarded call sites only. */
function fromEnd(all: string[], back: number): string {
  return all[all.length - back] ?? ''
}

function notFound(where: string): Error {
  return treeError('FileNotFoundError', `[Errno 2] No such file or directory: '${where}'`)
}

function isADirectory(where: string): Error {
  return treeError('IsADirectoryError', `[Errno 21] Is a directory: '${where}'`)
}

function notADirectory(where: string): Error {
  return treeError('NotADirectoryError', `[Errno 20] Not a directory: '${where}'`)
}

function fileExists(where: string): Error {
  return treeError('FileExistsError', `[Errno 17] File exists: '${where}'`)
}

function bothPaths(src: string, dst: string): string {
  return `'${src}' -> '${dst}'`
}

function toText(content: string | Uint8Array): string {
  if (typeof content === 'string') return content
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch (err) {
    throw treeError('UnicodeDecodeError', err instanceof Error ? err.message : String(err))
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

/**
 * The in-memory filesystem behind a monty guest's unmounted paths.
 *
 * The python binding hands monty an `OSAccess` subclass, and that base
 * class carries its own in-memory tree: a path no mount serves (a
 * guest temp file under `/tmp`, a scratch directory) is still a real
 * file to the guest. The JS binding is one bare callback with no tree
 * behind it — a declined call raises `PermissionError` — so this class
 * is that tree, host-side. Semantics and message spellings are pinned
 * to pydantic-monty's `os_access.py` (the exact strings a python-host
 * guest sees), with one deliberate improvement: renaming a file here
 * re-keys it fully, so the upstream rename-then-unlink KeyError the
 * python side works around (`MirageOSAccess._restamp`) cannot happen.
 *
 * One tree lives per `MirageOSAccess`, which is built per run: scratch
 * files last exactly one command, like python's.
 */
export class ScratchTree {
  private readonly root: DirNode = new Map([['/', new Map()]])

  private entryAt(path: string): TreeNode | null {
    const all = parts(path)
    if (all.length === 0) return null
    let dir: DirNode = this.root
    for (const part of all.slice(0, -1)) {
      const next = dir.get(part) ?? null
      if (!isDir(next)) return null
      dir = next
    }
    return dir.get(fromEnd(all, 1)) ?? null
  }

  private fileAt(path: string): FileNode {
    const entry = this.entryAt(path)
    if (entry === null) throw notFound(path)
    if (isDir(entry)) throw isADirectory(path)
    return entry
  }

  private dirAt(path: string): DirNode {
    const entry = this.entryAt(path)
    if (entry === null) throw notFound(path)
    if (!isDir(entry)) throw notADirectory(path)
    return entry
  }

  private parentOf(path: string): TreeNode | null {
    const all = parts(path)
    if (all.length === 0) return null
    if (all.length === 1) return this.root
    let dir: DirNode = this.root
    for (const part of all.slice(0, -2)) {
      const next = dir.get(part) ?? null
      if (!isDir(next)) return null
      dir = next
    }
    return dir.get(fromEnd(all, 2)) ?? null
  }

  exists(path: string): boolean {
    return this.entryAt(path) !== null
  }

  isFile(path: string): boolean {
    return isFile(this.entryAt(path))
  }

  isDir(path: string): boolean {
    return isDir(this.entryAt(path))
  }

  readText(path: string): string {
    return toText(this.fileAt(path).content)
  }

  readBytes(path: string): Uint8Array {
    return toBytes(this.fileAt(path).content)
  }

  write(path: string, data: string | Uint8Array): void {
    const entry = this.entryAt(path)
    if (isFile(entry)) {
      entry.content = data
      return
    }
    if (isDir(entry)) throw isADirectory(path)
    const parent = this.parentOf(path)
    if (!isDir(parent)) throw notFound(path)
    const all = parts(path)
    parent.set(fromEnd(all, 1), { content: data })
  }

  /**
   * Extend the file, keeping its storage type the way monty's tree
   * does: text appended to bytes decodes the base first, bytes onto
   * text encode it, so the stored shape tracks the most recent write.
   */
  append(path: string, data: string | Uint8Array): void {
    const entry = this.entryAt(path)
    if (isFile(entry)) {
      entry.content =
        typeof data === 'string'
          ? toText(entry.content) + data
          : concatBytes(toBytes(entry.content), data)
      return
    }
    if (isDir(entry)) throw isADirectory(path)
    this.write(path, data)
  }

  /**
   * The open-time effect for `open(path, mode)`, monty's own rules:
   * 'r' verifies the file exists and is not a directory, 'w' truncates
   * or creates, 'a' creates what is missing, 'x' refuses what exists.
   */
  open(path: string, mode: OpenMode): void {
    const empty = mode.binary ? new Uint8Array() : ''
    if (mode.exclusive) {
      if (this.entryAt(path) !== null) throw fileExists(path)
      this.write(path, empty)
      return
    }
    if (mode.truncate) {
      this.write(path, empty)
      return
    }
    if (mode.append) {
      const entry = this.entryAt(path)
      if (entry === null) this.write(path, empty)
      else if (isDir(entry)) throw isADirectory(path)
      return
    }
    const entry = this.entryAt(path)
    if (entry === null) throw notFound(path)
    if (isDir(entry)) throw isADirectory(path)
  }

  mkdir(path: string, parents: boolean, existOk: boolean): void {
    const entry = this.entryAt(path)
    if (isFile(entry)) throw fileExists(path)
    if (isDir(entry)) {
      if (existOk) return
      throw fileExists(path)
    }
    const parent = this.parentOf(path)
    const all = parts(path)
    if (isDir(parent)) {
      parent.set(fromEnd(all, 1), new Map())
      return
    }
    if (isFile(parent)) throw notADirectory(path)
    if (!parents) throw notFound(path)
    let dir: DirNode = this.root
    for (const part of all) {
      let next = dir.get(part)
      if (next === undefined) {
        next = new Map()
        dir.set(part, next)
      }
      if (!isDir(next)) throw notADirectory(path)
      dir = next
    }
  }

  unlink(path: string): void {
    this.fileAt(path)
    const parent = this.parentOf(path)
    if (!isDir(parent)) throw notFound(path)
    const all = parts(path)
    parent.delete(fromEnd(all, 1))
  }

  rmdir(path: string): void {
    const dir = this.dirAt(path)
    if (dir.size > 0) {
      throw treeError('OSError', `[Errno 39] Directory not empty: '${path}'`)
    }
    const parent = this.parentOf(path)
    if (!isDir(parent)) throw notFound(path)
    const all = parts(path)
    parent.delete(fromEnd(all, 1))
  }

  /** The directory's entries as full paths, in insertion order. */
  iterdir(path: string): string[] {
    const dir = this.dirAt(path)
    const base = path.endsWith('/') ? path : path + '/'
    return [...dir.keys()].map((name) => (path === '/' ? '/' + name : base + name))
  }

  rename(src: string, dst: string): void {
    const where = bothPaths(src, dst)
    const entry = this.entryAt(src)
    if (entry === null) {
      throw treeError('FileNotFoundError', `[Errno 2] No such file or directory: ${where}`)
    }
    const srcParent = this.parentOf(src)
    const dstParent = this.parentOf(dst)
    if (!isDir(srcParent) || !isDir(dstParent)) {
      throw treeError('FileNotFoundError', `[Errno 2] No such file or directory: ${where}`)
    }
    const target = this.entryAt(dst)
    if (isFile(entry)) {
      if (isDir(target)) throw treeError('IsADirectoryError', `[Errno 21] Is a directory: ${where}`)
    } else {
      if (isFile(target)) {
        throw treeError('NotADirectoryError', `[Errno 20] Not a directory: ${where}`)
      }
      if (isDir(target) && target.size > 0) {
        throw treeError('OSError', `[Errno 66] Directory not empty: ${where}`)
      }
    }
    const srcName = fromEnd(parts(src), 1)
    const dstName = fromEnd(parts(dst), 1)
    srcParent.delete(srcName)
    dstParent.set(dstName, entry)
  }
}
