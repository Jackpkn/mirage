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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec, wordText } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { ExecutionNode } from '../../types.ts'

export type Result = [ByteSource | null, IOResult, ExecutionNode]

const ENC = new TextEncoder()

interface ResultInit {
  out?: Uint8Array | null
  exitCode?: number
  stderr?: string
  io?: IOResult
}

/**
 * Build the (stream, IOResult, ExecutionNode) triple builtins return.
 *
 * @param cmd - command name recorded on the ExecutionNode.
 * @param init - `out` stdout payload; `exitCode` for both results; `stderr`
 *   error text encoded onto both; `io` a prebuilt IOResult to reuse (e.g.
 *   carrying writes), whose exitCode/stderr are overwritten.
 */
export function result(cmd: string, init: ResultInit = {}): Result {
  const exitCode = init.exitCode ?? 0
  const err =
    init.stderr !== undefined && init.stderr !== '' ? ENC.encode(init.stderr) : new Uint8Array()
  const io = init.io ?? new IOResult()
  io.exitCode = exitCode
  if (err.length > 0) io.stderr = err
  return [init.out ?? null, io, new ExecutionNode({ command: cmd, exitCode, stderr: err })]
}

export function ok(cmd: string, out?: Uint8Array | null): Result {
  return result(cmd, { out: out ?? null })
}

export function fail(cmd: string, message: string, exitCode = 1): Result {
  return result(cmd, { exitCode, stderr: message })
}

/**
 * Close an operand loop: exit 1 with joined stderr when any operand failed,
 * exit 0 otherwise.
 *
 * @param cmd - command name.
 * @param errors - per-operand error messages collected so far.
 * @param io - prebuilt IOResult to reuse (e.g. carrying writes).
 */
export function finish(cmd: string, errors: string[], io?: IOResult): Result {
  const carried = io !== undefined ? { io } : {}
  if (errors.length > 0) {
    return result(cmd, { exitCode: 1, stderr: errors.join(''), ...carried })
  }
  return result(cmd, carried)
}

/**
 * A non-path operand's text (a mode or owner spec the classifier may have
 * wrapped as a path).
 *
 * @param arg - a classified command part.
 */
export function operandText(arg: string | PathSpec): string {
  return arg instanceof PathSpec ? arg.virtual : arg
}

/**
 * A path operand as an absolute virtual path.
 *
 * @param arg - a classified command part.
 * @param cwd - session working directory for relative operands.
 */
export function absPath(arg: string | PathSpec, cwd: string): string {
  if (arg instanceof PathSpec) return arg.virtual
  return resolvePath(arg, cwd)
}

function allKnown(chars: string, known: string): boolean {
  for (const c of chars) if (!known.includes(c)) return false
  return true
}

/**
 * Split leading single-letter flags, permissively.
 *
 * A token containing any unknown letter is kept as an operand instead of
 * erroring (`ln`/`readlink` behavior).
 *
 * @param args - args after the command name.
 * @param known - accepted single-letter flags.
 * @returns [flags, operands].
 */
export function splitFlags(
  args: (string | PathSpec)[],
  known: string,
): [Set<string>, (string | PathSpec)[]] {
  const flags = new Set<string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  for (const arg of args) {
    const s = operandText(arg)
    if (parsing && s === '--') {
      parsing = false
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && allKnown(s.slice(1), known)) {
      for (const c of s.slice(1)) flags.add(c)
      continue
    }
    parsing = false
    operands.push(arg)
  }
  return [flags, operands]
}

export interface SplitValueFlags {
  flags: Set<string>
  values: Map<string, string>
  operands: (string | PathSpec)[]
  bad: string | null
}

/**
 * Split leading flags where some take a value (`-t STAMP`), strictly: an
 * unknown letter is reported instead of tolerated.
 *
 * @param args - args after the command name.
 * @param boolean - single-letter flags with no value.
 * @param valued - single-letter flags that consume the next arg.
 */
export function splitValueFlags(
  args: readonly (string | PathSpec)[],
  boolean: string,
  valued: string,
): SplitValueFlags {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) break
    const s = operandText(arg)
    if (parsing && s === '--') {
      parsing = false
      i += 1
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && !s.startsWith('--')) {
      const body = s.slice(1)
      for (let j = 0; j < body.length; j++) {
        const c = body.charAt(j)
        if (boolean.includes(c)) {
          flags.add(c)
          continue
        }
        // A valued flag consumes the rest of the token (-tSTAMP) or the next
        // argument (-t STAMP); those trailing chars are its value, not flags,
        // so validation must stop here rather than pre-scanning the token.
        if (!valued.includes(c)) {
          return { flags, values, operands, bad: c }
        }
        const rest = body.slice(j + 1)
        if (rest.length > 0) {
          values.set(c, rest)
        } else if (i + 1 < args.length) {
          i += 1
          const nxt = args[i]
          if (nxt !== undefined) values.set(c, wordText(nxt))
        }
        break
      }
      i += 1
      continue
    }
    parsing = false
    operands.push(arg)
    i += 1
  }
  return { flags, values, operands, bad: null }
}

/**
 * Coerce operands to PathSpec and expand glob patterns per mount.
 *
 * A pattern spec only exists for a mounted word (classification gates it), so
 * the lookup propagates on a miss; a backend with no glob keeps the literal
 * spec.
 *
 * @param namespace - addressing authority (mount lookup).
 * @param operands - positional operands.
 */
export async function expandOperands(
  namespace: Namespace,
  operands: readonly (string | PathSpec)[],
): Promise<PathSpec[]> {
  const out: PathSpec[] = []
  for (const item of operands) {
    const spec = item instanceof PathSpec ? item : PathSpec.fromStrPath(item)
    if (spec.pattern !== null) {
      const mount = namespace.mountFor(spec.virtual)
      if (mount.resource.glob !== undefined) {
        const prefix = rstripSlash(mount.prefix)
        const withPrefix = new PathSpec({
          virtual: spec.virtual,
          directory: spec.directory,
          pattern: spec.pattern,
          resolved: spec.resolved,
          resourcePath: mountKey(spec.virtual, prefix),
        })
        const expanded = await mount.resource.glob([withPrefix], prefix)
        for (const p of expanded) if (p instanceof PathSpec) out.push(p)
        continue
      }
    }
    out.push(spec)
  }
  return out
}
