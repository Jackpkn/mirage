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

import type { ByteSource, IOResult } from '../../../io/types.ts'
import type { LanguageRuntime } from '../../../runtime/language.ts'
import { QuickJsUnavailableError } from '../../../runtime/js/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { ExecutionNode } from '../../types.ts'
import { makeInterpreterHandler } from '../interpreter.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export interface HandleJsDeps {
  runtime: LanguageRuntime
}

const runJs = makeInterpreterHandler({
  label: 'js',
  payloadFlag: '-e',
  isUnavailable: (err: unknown) => err instanceof QuickJsUnavailableError,
})

export async function handleJs(
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: {
    stdin: ByteSource | null
    env: Record<string, string>
    code: string | null
    module: boolean
    signal?: AbortSignal
    timeoutSeconds?: number
  },
  deps: HandleJsDeps,
): Promise<Result> {
  // A .mjs script is a module whatever the flag said (Python's js.py).
  const module = opts.module || (pathScope?.virtual.endsWith('.mjs') ?? false)
  return runJs(
    dispatch,
    pathScope,
    args,
    {
      stdin: opts.stdin,
      env: opts.env,
      code: opts.code,
      flags: { module },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    deps,
  )
}
