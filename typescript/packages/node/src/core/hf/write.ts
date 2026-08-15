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

import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import type { HfAccessor } from '../../accessor/hf.ts'
import { hfKey, isNotFound, rawPathOf } from './util.ts'

export async function write(
  accessor: HfAccessor,
  path: PathSpec,
  data: Uint8Array,
  _index?: IndexCacheStore,
): Promise<void> {
  const rawPath = rawPathOf(path)
  const key = hfKey(rawPath)
  const op = await accessor.operator()
  const startMs = performance.now()
  try {
    await op.write(key, Buffer.from(data))
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    throw err
  }
  record('write', path.virtual, accessor.resourceName, data.byteLength, startMs)
  await invalidateAfterWrite(path)
  await invalidateAncestors(path)
}
