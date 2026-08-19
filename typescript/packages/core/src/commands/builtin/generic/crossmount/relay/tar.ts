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

import { IOResult } from '../../../../../io/types.ts'
import { tarGeneric } from '../../tar.ts'
import { crossOpts, statOp, streamOp } from '../utils.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

/**
 * Run a -t/-x tar whose archive and -C destination span mounts.
 *
 * Pure wiring: the shared generic runs on dispatch-relayed doors, so
 * the archive is read from its mount and every extracted path lands on
 * whichever mount owns it. Create mode never reaches here: the executor
 * keeps a create-mode span on the plain refusal, because its planner
 * walks one backend's tree and relay doors would cross nested mount
 * boundaries the planner is required to refuse.
 */
export async function runTar(
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const result = await tarGeneric(
    [],
    textArgs,
    crossOpts(flagKwargs),
    {
      stream: streamOp(dispatch),
      write: async (p, data) => {
        await dispatch('write', p, [data])
      },
      mkdir: async (p) => {
        await dispatch('mkdir', p)
      },
      stat: statOp(dispatch),
      walk: () => Promise.resolve({ paths: [] }),
      isDir: () => Promise.resolve(false),
    },
    true,
  )
  return result ?? [null, new IOResult()]
}
