import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { write } from './write.ts'

export function create(
  accessor: NextcloudAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  return write(accessor, path, new Uint8Array(), index)
}
