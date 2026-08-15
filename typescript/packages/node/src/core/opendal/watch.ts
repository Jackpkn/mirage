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
  mountPrefixOf,
  statFingerprint,
  stripSlash,
  type PathSpec,
  type WalkEntry,
} from '@struktoai/mirage-core'
import type { Metadata, Operator } from 'opendal'
import { isNotFound } from '../nextcloud/util.ts'
import type { OperatorAccessor } from './types.ts'

async function statOrNull(operator: Operator, key: string): Promise<Metadata | null> {
  try {
    return await operator.stat(key)
  } catch (error) {
    // Deleted between the listing and the stat; the next pull reports
    // the DELETE from the snapshot diff.
    if (isNotFound(error)) return null
    throw error
  }
}

/**
 * Recursive opendal list feeding the generic listing differ.
 *
 * Reads through the operator directly (one recursive LIST), never through
 * mirage's caches, as the DeltaHook contract requires. Fingerprints use
 * mirage's default: the native ETag when the listing carries one, `mtime|size`
 * otherwise.
 *
 * Some opendal services answer LIST without per-entry metadata (the hf lister
 * does; WebDAV's PROPFIND does not), which would leave every file
 * unfingerprinted and reduce detection to create/delete. When a listed file
 * carries no metadata at all, one `stat` per affected file fills the gap,
 * mirroring what the hf readdir already does for sizes. A backend whose lister
 * is complete never pays for it.
 */
export class OpendalWalk {
  private readonly accessor: OperatorAccessor

  constructor(accessor: OperatorAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.resourcePath)
    const base = stripSlash(root.resourcePath)
    const listPath = base !== '' ? `${base}/` : '/'
    const operator = await this.accessor.operator()
    let entries
    try {
      entries = await operator.list(listPath, { recursive: true })
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    for (const entry of entries) {
      const relative = entry.path()
      if (relative === '' || relative === listPath) continue
      let metadata: Metadata | null = entry.metadata()
      const isDir = relative.endsWith('/') || metadata.isDirectory()
      const resourcePath = stripSlash(relative)
      const virtual = prefix !== '' ? `${prefix}/${resourcePath}` : `/${resourcePath}`
      if (isDir) {
        yield { virtual, isDir: true, fingerprint: null }
        continue
      }
      if (
        metadata.etag === null &&
        metadata.lastModified === null &&
        metadata.contentLength === null
      ) {
        metadata = await statOrNull(operator, resourcePath)
      }
      const modified = metadata?.lastModified ?? null
      const size =
        metadata?.contentLength === null || metadata?.contentLength === undefined
          ? null
          : Number(metadata.contentLength)
      yield {
        virtual,
        isDir: false,
        fingerprint: statFingerprint(metadata?.etag ?? null, modified, size),
        size,
        modified,
      }
    }
  }
}
