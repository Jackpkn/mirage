import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { nextcloudKey } from './util.ts'

/**
 * Create a collection; opendal creates missing parents either way.
 *
 * `parents` is accepted for the op signature and ignored, because
 * `createDir` is MKCOL over every missing level whatever it says. That is
 * also why the ancestor invalidation is unconditional: a bare `mkdir a/b/c`
 * materializes a whole chain here, and gating the walk on `parents` (as the
 * backends whose mkdir really does create one level correctly do) left every
 * ancestor above the parent serving a cached listing that hid the new levels
 * until the index TTL expired.
 */
export async function mkdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  _parents = false,
): Promise<void> {
  const key = `${rstripSlash(nextcloudKey(path))}/`
  const op = await accessor.operator()
  await op.createDir(key)
  await invalidateAfterWrite(path)
  await invalidateAncestors(path)
}
