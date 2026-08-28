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

import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { type Redirect, RedirectKind } from '../../../../shell/types.ts'
import { fsStrerror, isFsError } from '../../../../utils/errors.ts'
import type { PathSpec } from '../../../../types.ts'
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { createFile } from '../../create.ts'
import { toScope } from '../scope.ts'
import { CLOSED } from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'

/** The `exec` builtin without redirects: bare `exec` is a no-op that
 * succeeds; `exec CMD` has no OS-process referent and is refused. */
export function handleExecCommand(args: string[], _session: Session): Result {
  if (args.length === 0)
    return [null, new IOResult(), new ExecutionNode({ command: 'exec', exitCode: 0 })]
  const err = new TextEncoder().encode(
    `mirage: exec: ${args[0] ?? ''}: process replacement is not supported ` +
      '(no OS process to replace)\n',
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: 'exec', exitCode: 2, stderr: err }),
  ]
}

function execError(label: string, err: unknown): Result {
  const strerror = isFsError(err) ? (fsStrerror(err) ?? '') : ''
  const line = new TextEncoder().encode(strerror !== '' ? `${label}: ${strerror}\n` : `${label}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: line }),
    new ExecutionNode({ command: 'exec', exitCode: 1, stderr: line }),
  ]
}

function scopeOf(target: unknown): PathSpec {
  return typeof target === 'string' ? toScope(target) : (target as PathSpec)
}

/**
 * Point the shell's own streams at files for the rest of the shell. `exec
 * > file` diverts later stdout, `2> file` stderr, `< file` stdin, `>>`
 * appends; `2>&1`/`>&2` copy one target onto the other; `>&-` closes.
 * The output file is opened now, as bash opens it at exec time.
 */
export async function installExecRedirects(
  dispatch: DispatchFn,
  session: Session,
  redirects: Redirect[],
): Promise<Result> {
  for (const r of redirects) {
    if (r.kind === RedirectKind.STDIN) {
      if (typeof r.target === 'number') {
        session.execStdin = null
        continue
      }
      const scope = scopeOf(r.target)
      try {
        const [data] = await dispatch('read', scope)
        session.execStdin = await materialize(data as ByteSource)
      } catch (err) {
        if (!isFsError(err)) throw err
        return execError(scope.rawPath, err)
      }
      continue
    }
    if (r.kind === RedirectKind.STDERR_TO_STDOUT && typeof r.target === 'number') {
      session.execStderr = session.execStdout
      session.execStderrAppend = session.execStdoutAppend
      continue
    }
    if (r.fd === 1 && r.target === 2) {
      session.execStdout = session.execStderr
      session.execStdoutAppend = session.execStderrAppend
      continue
    }
    if (typeof r.target === 'number' && r.target === -1) {
      // `>&-` / `<&-`: close the descriptor. The STDIN kind is handled
      // in the first branch, so only the two output kinds reach here.
      if (r.kind === RedirectKind.STDERR) session.execStderr = CLOSED
      else session.execStdout = CLOSED
      continue
    }
    if (typeof r.target === 'number') continue
    const scope = scopeOf(r.target)
    const path = scope.virtual
    try {
      if (await openTarget(dispatch, session, scope, r.append)) session.execOpened.add(path)
    } catch (err) {
      if (!isFsError(err)) throw err
      return execError(scope.rawPath, err)
    }
    const streams =
      r.fd === -1 ? ['stdout', 'stderr'] : r.kind === RedirectKind.STDERR ? ['stderr'] : ['stdout']
    for (const stream of streams) {
      if (stream === 'stderr') {
        session.execStderr = path
        session.execStderrAppend = r.append
      } else {
        session.execStdout = path
        session.execStdoutAppend = r.append
      }
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'exec', exitCode: 0 })]
}

/**
 * Open an `exec` redirect target, the way bash does at `exec` time:
 * truncating creates the file empty, appending creates it only when it
 * is not already there so an existing one keeps its bytes. Either way
 * the file exists before the next statement runs, which is what makes
 * `exec >> new; test -e new` succeed with nothing written. Returns
 * whether it was written, which is what marks the target opened.
 */
async function openTarget(
  dispatch: DispatchFn,
  session: Session,
  scope: PathSpec,
  append: boolean,
): Promise<boolean> {
  if (append) {
    try {
      await dispatch('stat', scope)
      return false
    } catch (err) {
      if (!isFsError(err)) throw err
    }
  }
  await createFile(dispatch, session, scope, new Uint8Array(0))
  return true
}

/**
 * Send one statement's output to the shell's `exec` targets: a stream
 * pointing at a file is appended to it and cleared so it does not also
 * reach the terminal; a closed stream drops. Returns the stdout that
 * should still bubble up (null once diverted).
 */
export async function divertStatement(
  dispatch: DispatchFn,
  session: Session,
  stdout: Uint8Array | null,
  io: IOResult,
): Promise<Uint8Array | null> {
  if (session.execStdout !== null) {
    if (stdout !== null && stdout.byteLength > 0) {
      await appendTo(dispatch, session, session.execStdout, stdout)
    }
    stdout = null
  }
  if (session.execStderr !== null && io.stderr != null) {
    const data = await materialize(io.stderr)
    if (data.byteLength > 0) await appendTo(dispatch, session, session.execStderr, data)
    io.stderr = null
  }
  return stdout
}

async function appendTo(
  dispatch: DispatchFn,
  session: Session,
  target: string,
  data: Uint8Array,
): Promise<void> {
  if (target === CLOSED) return
  const scope = toScope(target)
  let existing: Uint8Array = new Uint8Array(0)
  try {
    const [prior] = await dispatch('read', scope)
    existing = await materialize(prior as ByteSource)
  } catch (err) {
    if (!isFsError(err)) throw err
  }
  const combined: Uint8Array<ArrayBuffer> = new Uint8Array(existing.byteLength + data.byteLength)
  combined.set(existing, 0)
  combined.set(data, existing.byteLength)
  try {
    await dispatch('write', scope, [combined])
    session.execOpened.add(target)
  } catch (err) {
    if (!isFsError(err)) throw err
  }
}

/**
 * The `exec` arm. The redirect-only form is intercepted where redirects
 * are applied; a bare `exec` here has none, and `exec cmd` is the
 * process-replacement form this refuses.
 */
export function execBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleExecCommand([...call.argv.args], call.session))
}
