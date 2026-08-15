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

import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { eaccesReadOnly, enoent } from '../../utils/errors.ts'
import {
  isNotFoundError,
  loadS3Module,
  rawPathOf,
  s3Key,
  s3Prefix,
  withClient,
  type S3SendClient,
} from './_client.ts'
import { exists } from './exists.ts'

const DELETE_BATCH = 1000

// Whether one key names an object, as opposed to a directory prefix. The
// source is classified before anything is copied rather than by letting
// CopyObject fail: stores disagree about a missing source (S3 and MinIO
// even spell the code differently, and a lenient S3-compatible store
// accepts the copy and writes nothing), and on that last one an
// error-driven fallback would delete a source whose copy never landed.
// Only a classified not-found answers false; every other failure
// propagates rather than reading as a directory.
async function isObject(accessor: S3Accessor, client: S3SendClient, key: string): Promise<boolean> {
  const { HeadObjectCommand } = await loadS3Module(accessor.config)
  try {
    await client.send(new HeadObjectCommand({ Bucket: accessor.config.bucket, Key: key }))
  } catch (err) {
    if (!isNotFoundError(err)) throw err
    return false
  }
  return true
}

// A directory is a key prefix plus the empty marker object mkdir writes,
// and listing on the prefix returns both, so one walk moves the marker and
// the whole subtree together. Returns whether any key was found.
async function movePrefix(
  accessor: S3Accessor,
  client: S3SendClient,
  src: PathSpec,
  srcPfx: string,
  dstPfx: string,
): Promise<boolean> {
  const { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = await loadS3Module(
    accessor.config,
  )
  const { bucket } = accessor.config
  const moved: { Key: string }[] = []
  let continuationToken: string | undefined
  do {
    const input: Record<string, unknown> = { Bucket: bucket, Prefix: srcPfx }
    if (continuationToken !== undefined) input.ContinuationToken = continuationToken
    const resp = (await client.send(new ListObjectsV2Command(input))) as {
      Contents?: { Key?: string }[]
      IsTruncated?: boolean
      NextContinuationToken?: string
    }
    for (const obj of resp.Contents ?? []) {
      if (obj.Key === undefined) continue
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${obj.Key}`,
          Key: `${dstPfx}${obj.Key.slice(srcPfx.length)}`,
        }),
      )
      moved.push({ Key: obj.Key })
    }
    continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
  } while (continuationToken !== undefined)
  if (moved.length === 0) return false
  // Deleted only after every copy landed: a partial move that dropped the
  // source would lose the entries that had not been copied yet.
  const failed: string[] = []
  for (let start = 0; start < moved.length; start += DELETE_BATCH) {
    const resp = (await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: moved.slice(start, start + DELETE_BATCH) },
      }),
    )) as { Errors?: { Key?: string }[] }
    // DeleteObjects reports a refused key in the body of a 200, so a
    // response that throws nothing can still have deleted nothing.
    // Ignoring it would leave the source tree in place beside the copy and
    // call the move a success.
    for (const err of resp.Errors ?? []) failed.push(err.Key ?? '')
  }
  if (failed.length > 0) {
    // Both trees survive, which is what GNU mv leaves behind when the
    // unlink half fails after the copy half succeeded. EACCES because a
    // refused delete is a lock or a policy in practice, and because it is
    // an fs error: mv reports the operand and keeps going instead of
    // aborting the whole command line.
    throw eaccesReadOnly(
      `S3 refused to delete ${String(failed.length)} source object(s) after ` +
        `copying, starting at '${failed[0] ?? ''}'`,
      src,
    )
  }
  return true
}

// A single object moves with one server-side copy. A directory owns no
// object of its own, so it moves as a prefix walk; a source that is
// neither is ENOENT rather than the raw SDK text.
export async function rename(accessor: S3Accessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const { CopyObjectCommand, DeleteObjectCommand } = await loadS3Module(accessor.config)
  const srcKey = s3Key(rawPathOf(src), accessor.config)
  const dstKey = s3Key(rawPathOf(dst), accessor.config)
  const { bucket } = accessor.config
  if (srcKey === dstKey) {
    // POSIX rename(2): the same existing file succeeds and performs no
    // other action. Reaching the copy+delete pair below would instead
    // delete the object on any store that accepts the self-copy, and
    // error on the ones that reject it (#150).
    if (!(await exists(accessor, src))) throw enoent(src)
    return
  }
  await withClient(accessor.config, async (client) => {
    if (await isObject(accessor, client, srcKey)) {
      await client.send(
        new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${srcKey}`, Key: dstKey }),
      )
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: srcKey }))
      return
    }
    const srcPfx = s3Prefix(rawPathOf(src), accessor.config)
    const dstPfx = s3Prefix(rawPathOf(dst), accessor.config)
    if (!(await movePrefix(accessor, client, src, srcPfx, dstPfx))) throw enoent(src)
  })
  await invalidateAfterUnlink(dst)
  await invalidateAfterUnlink(src)
}
