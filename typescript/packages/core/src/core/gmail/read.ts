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
import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { PathSpec } from '../../types.ts'
import { getAttachment, getMessageRaw, messageJsonBytes } from './messages.ts'
import { readdir } from './readdir.ts'
import { gnuDirname } from '../../utils/path.ts'
import { eisdir, enoent } from '../../utils/errors.ts'

export async function read(
  accessor: GmailAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  const parentKey = gnuDirname(virtualKey)
  const entry = await entryOrWarm(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === null) throw enoent(path.virtual)
  const rt = entry.resourceType
  if (rt === 'gmail/label' || rt === 'gmail/date' || rt === 'gmail/attachment_dir') {
    throw eisdir(path.virtual)
  }
  if (rt === 'gmail/attachment') {
    const parentResult = await index.get(parentKey)
    if (parentResult.entry === undefined || parentResult.entry === null) {
      throw enoent(path.virtual)
    }
    return getAttachment(accessor.tokenManager, parentResult.entry.id, entry.id)
  }
  const raw = await getMessageRaw(accessor.tokenManager, entry.id)
  return messageJsonBytes(raw)
}
