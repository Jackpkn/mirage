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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../resource/s3/config.ts'
import {
  createS3Client,
  isNotFoundError,
  loadS3Module,
  s3Key,
  s3Prefix,
  type S3Module,
} from './_client.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { enotdir, readdirError } from '../../utils/errors.ts'

type Send = (cmd: unknown) => Promise<Record<string, unknown>>

async function isFile(send: Send, mod: S3Module, config: S3Config, key: string): Promise<boolean> {
  try {
    await send(new mod.HeadObjectCommand({ Bucket: config.bucket, Key: s3Key(key, config) }))
  } catch (err) {
    if (isNotFoundError(err)) return false
    throw err
  }
  return true
}

async function isDir(send: Send, mod: S3Module, config: S3Config, key: string): Promise<boolean> {
  const resp = (await send(
    new mod.ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: s3Prefix(key, config),
      Delimiter: '/',
      MaxKeys: 1,
    }),
  )) as { CommonPrefixes?: unknown[]; Contents?: unknown[] }
  return (resp.CommonPrefixes ?? []).length > 0 || (resp.Contents ?? []).length > 0
}

// The errno for a path the bucket holds no key at or under. Mirrors
// Python's mirage/core/s3/readdir.py `_listing_error`.
async function listingError(
  send: Send,
  mod: S3Module,
  config: S3Config,
  path: PathSpec,
  key: string,
): Promise<Error> {
  const file = (p: string): Promise<boolean> => isFile(send, mod, config, p)
  // An object, not a prefix: opendir(2) reports ENOTDIR, and the ancestor
  // walk cannot change that answer, because every ancestor of a stored key
  // is a prefix by construction.
  if (await file(key)) return enotdir(path)
  return readdirError(path, key, file, (p) => isDir(send, mod, config, p))
}

export async function readdir(
  accessor: S3Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const original = path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  // When called from resolveGlob with a pattern, use path.directory for the
  // listing; direct callers pass pattern=null so we use path.virtual.
  const virtual = path.pattern !== null ? path.directory : original
  const rawPath =
    prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual

  // Fast path: the index cache may already have this directory populated
  // from a previous readdir. Mirror Python's mirage/core/s3/readdir.py.
  const virtualKey = rawPath === '/' ? '/' : rstripSlash(rawPath) || '/'
  const rawFullKey = prefix !== '' ? `${prefix}${virtualKey}` : virtualKey
  const fullVirtualKey = rstripSlash(rawFullKey) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(fullVirtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }

  const { config } = accessor
  const mod = await loadS3Module(config)
  const { ListObjectsV2Command } = mod
  const client = await createS3Client(config)
  const send = (client as unknown as { send: Send }).send.bind(client)

  const entries = new Set<string>()
  const dirKeys = new Set<string>()
  const objects = new Map<
    string,
    { size: number | null; etag: string; lastModified: Date | string | undefined }
  >()
  const s3Pfx = s3Prefix(rawPath, config)
  let continuationToken: string | undefined
  let sawKey = false
  try {
    do {
      const input: Record<string, unknown> = {
        Bucket: config.bucket,
        Prefix: s3Pfx,
        Delimiter: '/',
      }
      if (continuationToken !== undefined) input.ContinuationToken = continuationToken
      const resp = (await send(new ListObjectsV2Command(input))) as {
        CommonPrefixes?: { Prefix?: string }[]
        Contents?: { Key?: string; Size?: number; ETag?: string; LastModified?: Date | string }[]
        IsTruncated?: boolean
        NextContinuationToken?: string
      }
      if ((resp.CommonPrefixes ?? []).length > 0 || (resp.Contents ?? []).length > 0) {
        sawKey = true
      }
      for (const cp of resp.CommonPrefixes ?? []) {
        const p = cp.Prefix
        if (p === undefined) continue
        const name = rstripSlash(p.slice(s3Pfx.length))
        if (name !== '') {
          entries.add(name)
          dirKeys.add(name)
        }
      }
      for (const obj of resp.Contents ?? []) {
        const k = obj.Key
        if (k === undefined || k === s3Pfx) continue
        const name = k.slice(s3Pfx.length)
        if (name !== '' && !name.includes('/')) {
          entries.add(name)
          objects.set(name, {
            size: obj.Size ?? null,
            etag: obj.ETag ?? '',
            lastModified: obj.LastModified,
          })
        }
      }
      continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
    if (!sawKey && rstripSlash(rawPath) !== '') {
      // An empty directory is a zero-byte marker object keyed at the prefix
      // itself, so a prefix holding no key at all -- not even that marker --
      // is a path the bucket does not have. Without this, `ls /s3/never`
      // rendered an empty directory and exited 0 where every real filesystem
      // reports ENOENT. The mount root is exempt: it exists because it is
      // mounted.
      throw await listingError(send, mod, config, path, rawPath)
    }
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
  // Align with RAM/Disk: return fully-qualified paths (mount prefix + directory + name)
  // so commands like `ls` can stat each entry without re-resolving.
  const mountPrefix = prefix
  const virtualDir = rawPath === '' || rawPath === '/' ? '/' : rstripSlash(rawPath) + '/'
  const sortedNames = [...entries].sort(compareCodePoints)
  const virtualEntries = sortedNames.map((name) => `${mountPrefix}${virtualDir}${name}`)

  // Populate the index as a side-effect so future stat()/readdir() calls
  // can hit the fast path. Mirrors Python's mirage/core/s3/readdir.py.
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = sortedNames.map((name) => {
      if (dirKeys.has(name)) {
        return [
          name,
          new IndexEntry({
            id: `${mountPrefix}${virtualDir}${name}/`,
            name,
            resourceType: ResourceType.FOLDER,
            vfsName: name,
          }),
        ]
      }
      const obj = objects.get(name)
      const modified = obj?.lastModified
      const remoteTime =
        modified instanceof Date
          ? modified.toISOString()
          : typeof modified === 'string'
            ? modified
            : ''
      return [
        name,
        new IndexEntry({
          id: `${mountPrefix}${virtualDir}${name}`,
          name,
          resourceType: ResourceType.FILE,
          vfsName: name,
          size: obj?.size ?? null,
          remoteTime,
        }),
      ]
    })
    await index.setDir(fullVirtualKey, indexEntries)
  }

  return virtualEntries
}
