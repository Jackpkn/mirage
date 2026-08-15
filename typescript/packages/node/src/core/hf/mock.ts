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

import type { Operator } from 'opendal'
import { vi } from 'vitest'
import type { HfAccessor } from '../../accessor/hf.ts'

export interface FakeHfOperator {
  files: Map<string, Buffer>
  read: (key: string, options?: { offset?: bigint; size?: bigint }) => Promise<Buffer>
  reader: (key: string) => Promise<{ read: (buf: Buffer) => Promise<bigint> }>
  stat: (key: string) => Promise<FakeMetadata>
  list: (path: string, options?: { recursive?: boolean }) => Promise<FakeEntry[]>
  write: (key: string, data: Buffer | string) => Promise<FakeMetadata>
  delete: (key: string) => Promise<void>
  createDir: (key: string) => Promise<void>
}

interface FakeMetadata {
  isDirectory: () => boolean
  isFile: () => boolean
  contentLength: bigint | null
  etag: string | null
  lastModified: string | null
}

interface FakeEntry {
  path: () => string
  name: () => string
  metadata: () => FakeMetadata
}

function notFound(op: string, key: string): Error {
  return new Error(`NotFound (permanent) at ${op}, context: { service: hf, path: ${key} }`)
}

function fileMetadata(data: Buffer): FakeMetadata {
  return {
    isDirectory: () => false,
    isFile: () => true,
    contentLength: BigInt(data.byteLength),
    etag: `etag-${String(data.byteLength)}`,
    lastModified: '2021-09-15T21:24:22Z',
  }
}

const DIR_METADATA: FakeMetadata = {
  isDirectory: () => true,
  isFile: () => false,
  contentLength: 0n,
  etag: null,
  lastModified: null,
}

export function fakeHfOperator(initial: Record<string, string | Buffer> = {}): FakeHfOperator {
  const files = new Map<string, Buffer>()
  for (const [key, value] of Object.entries(initial)) {
    files.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value))
  }
  const hasDir = (dirKey: string): boolean => {
    const pfx = dirKey === '' ? '' : dirKey.endsWith('/') ? dirKey : `${dirKey}/`
    if (pfx === '') return true
    return [...files.keys()].some((k) => k.startsWith(pfx))
  }
  return {
    files,
    read: (key, options) => {
      const data = files.get(key)
      if (data === undefined) return Promise.reject(notFound('read', key))
      const offset = Number(options?.offset ?? 0n)
      const size = options?.size !== undefined ? Number(options.size) : data.byteLength - offset
      return Promise.resolve(data.subarray(offset, offset + size))
    },
    reader: (key) => {
      const data = files.get(key)
      if (data === undefined) return Promise.reject(notFound('read', key))
      let pos = 0
      return Promise.resolve({
        read: (buf: Buffer) => {
          const n = Math.min(buf.byteLength, data.byteLength - pos)
          data.copy(buf, 0, pos, pos + n)
          pos += n
          return Promise.resolve(BigInt(n))
        },
      })
    },
    stat: (key) => {
      if (key.endsWith('/') || key === '') {
        const dirKey = key === '' ? '' : key.slice(0, -1)
        if (hasDir(dirKey)) return Promise.resolve(DIR_METADATA)
        return Promise.reject(notFound('stat', key))
      }
      const data = files.get(key)
      if (data !== undefined) return Promise.resolve(fileMetadata(data))
      if (hasDir(key)) return Promise.resolve(DIR_METADATA)
      return Promise.reject(notFound('stat', key))
    },
    list: (path, options) => {
      const pfx = path === '/' ? '' : path
      // The Hub answers a missing subpath with 200 and an empty array, and
      // the tree API lists children only -- nothing stands for the
      // directory itself. Probed against the fake hub through opendal
      // 0.47.1: list('never/') and list('a.txt/') both resolve to [] where
      // this fake used to reject, which would have made the readdir tests
      // below pass without ever reaching the empty-listing branch.
      const recursive = options?.recursive === true
      const seen = new Map<string, FakeEntry>()
      for (const [key, data] of files.entries()) {
        if (!key.startsWith(pfx)) continue
        const rest = key.slice(pfx.length)
        if (rest === '') continue
        const slash = rest.indexOf('/')
        if (recursive) {
          seen.set(key, {
            path: () => key,
            name: () => key.split('/').pop() ?? key,
            metadata: () => fileMetadata(data),
          })
          let dirRel = rest
          while (dirRel.includes('/')) {
            dirRel = dirRel.slice(0, dirRel.lastIndexOf('/'))
            const dirPath = `${pfx}${dirRel}/`
            seen.set(dirPath, {
              path: () => dirPath,
              name: () => dirRel.split('/').pop() ?? dirRel,
              metadata: () => DIR_METADATA,
            })
          }
        } else if (slash === -1) {
          seen.set(key, { path: () => key, name: () => rest, metadata: () => fileMetadata(data) })
        } else {
          const dirRel = rest.slice(0, slash)
          const dirPath = `${pfx}${dirRel}/`
          seen.set(dirPath, {
            path: () => dirPath,
            name: () => dirRel,
            metadata: () => DIR_METADATA,
          })
        }
      }
      return Promise.resolve([...seen.values()])
    },
    write: (key, data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      files.set(key, buf)
      return Promise.resolve(fileMetadata(buf))
    },
    delete: (key) => {
      files.delete(key)
      return Promise.resolve()
    },
    createDir: (_key) => Promise.resolve(),
  }
}

export function installFakeOperator(accessor: HfAccessor, fake: FakeHfOperator): void {
  vi.spyOn(accessor, 'operator').mockResolvedValue(fake as unknown as Operator)
}
