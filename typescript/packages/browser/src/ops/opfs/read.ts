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

import type { OpKwargs, PathSpec, RegisteredOp } from '@struktoai/mirage-core'
import { ResourceName } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { read as coreRead } from '../../core/opfs/read.ts'

// A backend that registers its own read op does not go through
// makeGenericOps, so neither the native-range dispatch nor the
// read-and-slice fallback reaches it: the window has to be read off
// kwargs here or it is silently dropped and the whole file comes back.
// OPFS slices natively (`File` is a `Blob`), so it is forwarded rather
// than applied after the read.
export const readOp: RegisteredOp = {
  name: 'read',
  resource: ResourceName.OPFS,
  filetype: null,
  write: false,
  fn: async (
    accessor: OPFSAccessor,
    path: PathSpec,
    _args: readonly unknown[],
    kwargs: OpKwargs,
  ) => {
    const offset = typeof kwargs.offset === 'number' ? kwargs.offset : 0
    const size = typeof kwargs.size === 'number' ? kwargs.size : null
    if (size === 0) return new Uint8Array(0)
    if (offset === 0 && size === null) return await coreRead(accessor, path)
    return await coreRead(
      accessor,
      path,
      kwargs.index,
      size === null ? { offset } : { offset, size },
    )
  },
}
