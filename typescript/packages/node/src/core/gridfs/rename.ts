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

import { enoent, invalidateAfterUnlink, type PathSpec } from '@struktoai/mirage-core'
import type { ObjectId } from 'mongodb'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import {
  deleteAll,
  filesColl,
  gridfsKey,
  gridfsPrefix,
  latestFile,
  prefixQuery,
  rawPathOf,
} from './_client.ts'

// A directory is a filename prefix plus the zero-byte `key/` marker mkdir
// writes, and the prefix query returns both, so one pass moves the marker
// and the whole subtree together. Returns whether any revision was found.
async function renamePrefix(
  accessor: GridFSAccessor,
  srcPfx: string,
  dstPfx: string,
): Promise<boolean> {
  const files = await filesColl(accessor)
  const docs: { _id: ObjectId; filename: string }[] = []
  for await (const doc of files.find(prefixQuery(srcPfx), {
    projection: { _id: 1, filename: 1 },
  })) {
    docs.push({ _id: doc._id, filename: doc.filename as string })
  }
  if (docs.length === 0) return false
  if (dstPfx !== srcPfx) {
    // Read the source docs before clearing the destination: on a
    // self-directed move the two queries select the same revisions, and
    // deleting first would drop what the retag is about to move.
    await deleteAll(accessor, prefixQuery(dstPfx))
  }
  for (const doc of docs) {
    await files.updateOne(
      { _id: doc._id },
      { $set: { filename: `${dstPfx}${doc.filename.slice(srcPfx.length)}` } },
    )
  }
  return true
}

// Server-side: retag every revision's filename instead of copying bytes,
// so the whole revision history moves with the file. A directory owns no
// revision of its own, so an absent source file falls through to the
// prefix retag; a source that is neither is ENOENT.
export async function rename(
  accessor: GridFSAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const srcKey = gridfsKey(rawPathOf(src), accessor.config)
  const dstKey = gridfsKey(rawPathOf(dst), accessor.config)
  if ((await latestFile(accessor, srcKey)) === null) {
    const srcPfx = gridfsPrefix(rawPathOf(src), accessor.config)
    const dstPfx = gridfsPrefix(rawPathOf(dst), accessor.config)
    if (!(await renamePrefix(accessor, srcPfx, dstPfx))) throw enoent(src)
  } else {
    if (dstKey !== srcKey) {
      await deleteAll(accessor, { filename: dstKey })
    }
    const files = await filesColl(accessor)
    await files.updateMany({ filename: srcKey }, { $set: { filename: dstKey } })
  }
  await invalidateAfterUnlink(dst)
  await invalidateAfterUnlink(src)
}
