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

import { IOResult } from '../../../../io/types.ts'
import { sleep } from '../../../abort.ts'
import { ExecutionNode } from '../../../types.ts'
import type { Result } from '../shared.ts'
import { SLEEP_INTERVAL } from './constants.ts'
import type { BuiltinCall } from '../types.ts'

export async function handleSleep(args: string[], signal?: AbortSignal): Promise<Result> {
  const raw = args[0]
  if (raw === undefined) {
    const err = new TextEncoder().encode('sleep: missing operand\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  // "1e309" passes the regex but overflows to Infinity, so check both.
  const seconds = SLEEP_INTERVAL.test(raw) ? Number(raw) : Infinity
  if (!Number.isFinite(seconds)) {
    const err = new TextEncoder().encode(`sleep: invalid time interval '${raw}'\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  await sleep(seconds * 1000, signal)
  return [null, new IOResult(), new ExecutionNode({ command: 'sleep', exitCode: 0 })]
}

/** The `sleep` arm; the abort signal ends the wait early. */
export async function sleepBuiltin(call: BuiltinCall): Promise<Result> {
  return handleSleep([...call.argv.args], call.signal)
}
