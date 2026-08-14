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

import { skipFirstLine } from '../../../commands/builtin/general/interpreter.ts'
import type { SourceMode } from '../../../commands/builtin/general/interpreter.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import type { LanguageRuntime } from '../../../runtime/language.ts'
import { PythonRuntime } from '../../../runtime/python/base.ts'
import type { InitFlags } from '../../../runtime/python/flags.ts'
import { MontyUnavailableError } from '../../../runtime/python/monty/index.ts'
import { PyodideUnavailableError } from '../../../runtime/python/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { ExecutionNode } from '../../types.ts'
import { makeInterpreterHandler } from '../interpreter.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export interface HandlePythonDeps {
  runtime: LanguageRuntime
}

const runPython = makeInterpreterHandler({
  label: 'python3',
  payloadFlag: '-c',
  isUnavailable: (err: unknown) =>
    err instanceof PyodideUnavailableError || err instanceof MontyUnavailableError,
})

// `-m` against a runtime that cannot run modules. Exit 1 is CPython's code
// for a `-m` that could not run, but not its "No module named" wording:
// nothing was searched for, so naming the runtime is the honest report.
function moduleRefusal(mode: SourceMode | undefined, runtime: LanguageRuntime): string | null {
  if (mode !== 'module') return null
  if (!(runtime instanceof PythonRuntime) || runtime.runsModules) return null
  return `python3: -m is not supported by the '${runtime.name}' runtime\n`
}

export async function handlePython(
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: {
    stdin: ByteSource | null
    env: Record<string, string>
    code: string | null
    // argv[0], derived from which door the source came through; '' is
    // CPython's own answer for a program piped in with no operand, so a
    // runtime must not treat it as absent.
    prog?: string
    mode?: SourceMode
    // CPython's -x. File mode only, which is CPython's own scope: -c,
    // -m and stdin are unaffected.
    skipFirstLine?: boolean
    initFlags?: InitFlags
    signal?: AbortSignal
    timeoutSeconds?: number
  },
  deps: HandlePythonDeps,
): Promise<Result> {
  return runPython(
    dispatch,
    pathScope,
    args,
    {
      stdin: opts.stdin,
      env: opts.env,
      code: opts.code,
      refuse: (runtime: LanguageRuntime) => moduleRefusal(opts.mode, runtime),
      ...(opts.prog !== undefined ? { prog: opts.prog } : {}),
      ...(opts.initFlags !== undefined ? { flags: opts.initFlags as Record<string, unknown> } : {}),
      ...(opts.skipFirstLine === true ? { transformSource: skipFirstLine } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    },
    deps,
  )
}
