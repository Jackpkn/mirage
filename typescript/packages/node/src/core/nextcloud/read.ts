import {
  enoent,
  record,
  ResourceName,
  type IndexCacheStore,
  type PathSpec,
  isShortRangeRefusal,
  sliceWindow,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export interface NextcloudReadOptions {
  offset?: number
  size?: number
}

export async function read(
  accessor: NextcloudAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: NextcloudReadOptions = {},
): Promise<Uint8Array> {
  const op = await accessor.operator()
  const readOptions: { offset?: bigint; size?: bigint } = {}
  if (options.offset !== undefined && options.offset > 0) {
    readOptions.offset = BigInt(options.offset)
  }
  if (options.size !== undefined) {
    readOptions.offset ??= 0n
    readOptions.size = BigInt(options.size)
  }
  const startMs = performance.now()
  try {
    const windowed = readOptions.offset !== undefined || readOptions.size !== undefined
    // OpenDAL's node binding refuses to return fewer bytes than the range
    // asked for, where a POSIX read comes back short, so a window that runs
    // past EOF has to be read unbounded and trimmed here. Python's binding
    // reads through a file object and is short naturally.
    let data: Buffer
    try {
      data = windowed
        ? await op.read(nextcloudKey(path), readOptions)
        : await op.read(nextcloudKey(path))
    } catch (rangeError) {
      if (!windowed || !isShortRangeRefusal(rangeError)) throw rangeError
      const from = Number(readOptions.offset ?? 0n)
      const whole = await op.read(nextcloudKey(path), { offset: BigInt(from) })
      data = Buffer.from(sliceWindow(new Uint8Array(whole), 0, options.size ?? null))
    }
    const bytes = new Uint8Array(data)
    record('read', path.virtual, ResourceName.NEXTCLOUD, bytes.byteLength, startMs)
    return bytes
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
}
