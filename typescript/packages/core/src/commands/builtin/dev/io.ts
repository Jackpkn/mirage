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

import type { RAMAccessor } from '../../../accessor/ram.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { read, readRange, stat, stream } from '../../../core/dev/index.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { RAM_IO } from '../ram/io.ts'

async function* finiteStream(
  accessor: RAMAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  if (data.byteLength > 0) yield data
}

export const DEV_STREAMING_IO: CommandIO<RAMAccessor> = {
  ...RAM_IO,
  readBytes: read,
  readRange,
  readStream: stream,
  stat,
}

export const DEV_IO: CommandIO<RAMAccessor> = {
  ...DEV_STREAMING_IO,
  readStream: finiteStream,
}
