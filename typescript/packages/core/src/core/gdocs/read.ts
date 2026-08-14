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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GDocsAccessor } from '../../accessor/gdocs.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { PathSpec } from '../../types.ts'
import { docsBase, type TokenManager, googleGet } from '../google/_client.ts'
import { readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../utils/errors.ts'

const ENC = new TextEncoder()

export async function readDoc(tm: TokenManager, docId: string): Promise<Uint8Array> {
  const url = `${docsBase(tm)}/documents/${docId}`
  const data = await googleGet(tm, url)
  return ENC.encode(JSON.stringify(data))
}

export async function read(
  accessor: GDocsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry = await entryOrWarm(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'gdocs/directory') throw eisdir(path.virtual)
  return readDoc(accessor.tokenManager, entry.id)
}

export async function* stream(
  accessor: GDocsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  yield data
}
