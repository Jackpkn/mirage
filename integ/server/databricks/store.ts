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

import { tenantWhere } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'

export interface NodeRow {
  path: string
  isDirectory: boolean
  // Prisma reads a `Bytes` column back as a Uint8Array, not a Buffer, and the
  // kit only recognizes a Buffer as a raw body: typing this as Buffer made
  // every file read answer a JSON object of byte values. `bytesOf` is the one
  // place that conversion happens.
  data: Uint8Array | null
  lastModified: number
  seq: number
}

export function bytesOf(row: NodeRow): Buffer {
  return row.data === null ? Buffer.alloc(0) : Buffer.from(row.data)
}

// Prisma types a Bytes column as Uint8Array<ArrayBuffer>, and a Buffer is a
// Uint8Array<ArrayBufferLike>, which is wider: the two are interchangeable at
// runtime and not assignable at compile time. Narrow once here rather than at
// each write.
function toBytes(data: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(data.length))
  out.set(data)
  return out
}

// posixpath.normpath("/" + path.strip("/")), which collapses "//" and resolves
// "." and ".." without touching a filesystem. Written out because node's
// path.posix.normalize keeps a trailing slash and answers "." for the empty
// string, and a path that normalizes differently in the two fakes is a
// divergence no golden would explain.
export function norm(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`.replace(/\/$/, '') || '/'
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function where(tenant: string, path: string): { tenant_path: { tenant: string; path: string } } {
  return { tenant_path: { tenant, path } }
}

export async function nextSeq(db: C, tenant: string): Promise<number> {
  const top = await db.databricksNode.findFirst({
    where: tenantWhere(tenant, config.tenantKind),
    orderBy: { seq: 'desc' },
  })
  return top === null ? 0 : top.seq + 1
}

export async function nodeAt(db: C, tenant: string, path: string): Promise<NodeRow | null> {
  return (await db.databricksNode.findUnique({ where: where(tenant, path) })) as NodeRow | null
}

export async function fileAt(db: C, tenant: string, path: string): Promise<NodeRow | null> {
  const row = await nodeAt(db, tenant, path)
  return row === null || row.isDirectory ? null : row
}

export async function isDir(db: C, tenant: string, path: string): Promise<boolean> {
  const row = await nodeAt(db, tenant, path)
  return row !== null && row.isDirectory
}

// Every ancestor of a written path becomes a directory, which is what the
// python store's _add_ancestors did on both put_file and make_dir. A databricks
// volume has no mkdir -p, so a file written three levels down has to leave the
// two directories above it listable.
export async function addAncestors(db: C, tenant: string, path: string): Promise<void> {
  let current = parentOf(path)
  for (;;) {
    let seq = 0
    if ((await nodeAt(db, tenant, current)) === null) seq = await nextSeq(db, tenant)
    await db.databricksNode.upsert({
      where: where(tenant, current),
      update: { isDirectory: true, data: null },
      create: { tenant, path: current, isDirectory: true, data: null, lastModified: 0, seq },
    })
    if (current === '/') return
    current = parentOf(current)
  }
}

export async function putFile(
  db: C,
  tenant: string,
  path: string,
  data: Buffer,
  mtimeMs: number,
): Promise<void> {
  const at = norm(path)
  const existing = await nodeAt(db, tenant, at)
  const seq = existing === null ? await nextSeq(db, tenant) : existing.seq
  await db.databricksNode.upsert({
    where: where(tenant, at),
    update: { isDirectory: false, data: toBytes(data), lastModified: mtimeMs },
    create: {
      tenant,
      path: at,
      isDirectory: false,
      data: toBytes(data),
      lastModified: mtimeMs,
      seq,
    },
  })
  await addAncestors(db, tenant, at)
}

export async function makeDir(db: C, tenant: string, path: string): Promise<void> {
  const at = norm(path)
  if ((await nodeAt(db, tenant, at)) === null) {
    await db.databricksNode.create({
      data: {
        tenant,
        path: at,
        isDirectory: true,
        data: null,
        lastModified: 0,
        seq: await nextSeq(db, tenant),
      },
    })
  }
  await addAncestors(db, tenant, at)
}

export async function deleteNode(db: C, tenant: string, path: string): Promise<void> {
  await db.databricksNode.delete({ where: where(tenant, norm(path)) })
}

// A directory delete takes the subtree with it. The prefix carries its own
// trailing slash so "/a/bc" is not swept away with "/a/b".
export async function deleteTree(db: C, tenant: string, path: string): Promise<void> {
  const at = norm(path)
  await db.databricksNode.deleteMany({
    where: { ...tenantWhere(tenant, config.tenantKind), path: { startsWith: `${at}/` } },
  })
  await db.databricksNode.delete({ where: where(tenant, at) })
}

// Children of one directory, files before directories and each in insertion
// order, which is the order the two python dicts iterated in.
export async function childrenOf(db: C, tenant: string, path: string): Promise<NodeRow[]> {
  const at = norm(path)
  const rows = (await db.databricksNode.findMany({
    where: tenantWhere(tenant, config.tenantKind),
    orderBy: { seq: 'asc' },
  })) as NodeRow[]
  const kids = rows.filter((r) => r.path !== '/' && parentOf(r.path) === at)
  return [...kids.filter((r) => !r.isDirectory), ...kids.filter((r) => r.isDirectory)]
}
