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

import { envNames } from '../../commands/cli/walk.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { VFSRuntime } from '../../runtime/table.ts'
import { SecretsError } from '../../secrets/errors.ts'
import { fetchSecret } from '../../secrets/registry.ts'
import { commandWords, referencedNames } from '../../shell/parse.ts'
import type { ManagedRef, ShellVar } from '../../shell/variable.ts'
import { withValue } from '../../shell/variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { CLIInstall } from '../cli/types.ts'
import { setSessionEntry, type Session } from '../session/session.ts'

// Commands that render the whole environment, so every managed name is
// about to be read whether or not the line spells one.
export const WHOLE_ENV_COMMANDS: ReadonlySet<string> = new Set([
  'env',
  'printenv',
  'export',
  'declare',
  'set',
])

/**
 * Whether any of the line's commands runs on a guest runtime.
 *
 * A guest receives the exported environment as one snapshot, so every
 * managed name may be read whatever the line spells --
 * `python3 -c 'os.environ[...]'` never writes a `$NAME` the walk could
 * see. The vfs runtime is the executor itself, whose commands read
 * vars one at a time, so it does not count. Keyed on the line's own
 * command words because the static table binds every captured command
 * in the workspace, not this line's.
 */
export function guestBound(
  node: TSNodeLike,
  decision: RouteDecision | null,
  staticBindings: Record<string, Runtime | null>,
): boolean {
  const bindings = decision !== null ? decision.bindings : staticBindings
  const words = commandWords(node)
  for (const word of [...words, '*']) {
    const runtime = Object.hasOwn(bindings, word) ? bindings[word] : undefined
    if (runtime != null && !(runtime instanceof VFSRuntime)) return true
  }
  return false
}

/**
 * Env names the line's installed CLIs read.
 *
 * An installed CLI reads a managed name through `Option.env` with no
 * `$NAME` in the line's text, so the fill set has to be told: for each
 * command word that is an installed head word, every env name its
 * program tree declares.
 */
export function cliEnvNames(node: TSNodeLike, clis: Map<string, CLIInstall>): ReadonlySet<string> {
  if (clis.size === 0) return new Set()
  const words = commandWords(node)
  const out = new Set<string>()
  for (const [head, install] of clis) {
    if (words.has(head)) {
      for (const name of envNames(install.spec)) out.add(name)
    }
  }
  return out
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) if (b.has(item)) return true
  return false
}

/**
 * Fetch the managed values one line is about to read.
 *
 * The session is the truth, not the workspace's declaration: it may
 * carry entries the workspace never declared (per-session env, a
 * hydrated record), and a var that already holds a value never
 * refetches -- which also makes the re-entrant fill of a nested eval
 * idempotent. Fetches group by `(source, ref)`, one await per distinct
 * secret, and the fetched value lands directly in `session.vars` with
 * the pointer kept: this is the one host-tier writer, above the
 * agent's gated door.
 *
 * A failed fetch, or a secret without the wanted field, throws
 * SecretsError naming the variable and the source -- never the ref and
 * never any value -- and the executor folds it into the line's result
 * (exit 1), so a dead source fails exactly the commands that need it.
 *
 * `whole` says the line runs as one opaque program (a whole-line
 * runtime), so every managed name may be read.
 */
export async function fillEnv(
  session: Session,
  node: TSNodeLike,
  whole: boolean,
  lineCliEnvNames: ReadonlySet<string>,
): Promise<void> {
  const pending = new Map<string, ManagedRef>()
  const records = new Map<string, ShellVar>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (v.managed === undefined || v.value !== null) continue
    pending.set(name, v.managed)
    records.set(name, v)
  }
  if (pending.size === 0) return
  let names: string[]
  if (whole || intersects(WHOLE_ENV_COMMANDS, commandWords(node))) {
    names = [...pending.keys()]
  } else {
    const wanted = new Set([...referencedNames(node), ...lineCliEnvNames])
    for (const [name, ref] of pending) {
      if (ref.eager) wanted.add(name)
    }
    names = [...pending.keys()].filter((name) => wanted.has(name))
  }
  if (names.length === 0) return
  const groups = new Map<string, string[]>()
  const pointers = new Map<string, ManagedRef>()
  for (const name of names.sort()) {
    const pointer = pending.get(name) as ManagedRef
    const groupKey = JSON.stringify([pointer.source, pointer.ref])
    pointers.set(groupKey, pointer)
    const group = groups.get(groupKey)
    if (group === undefined) groups.set(groupKey, [name])
    else group.push(name)
  }
  for (const [groupKey, group] of groups) {
    const pointer = pointers.get(groupKey) as ManagedRef
    let secret
    try {
      secret = await fetchSecret(pointer.source, pointer.ref)
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught)
      throw new SecretsError(`${group.join(', ')}: cannot fetch from ${pointer.source}: ${detail}`, {
        cause: caught,
      })
    }
    for (const name of group) {
      const key = (pending.get(name) as ManagedRef).key
      const value = Object.hasOwn(secret.fields, key) ? secret.fields[key] : undefined
      if (value === undefined) {
        const had = Object.keys(secret.fields).sort().join(', ')
        throw new SecretsError(
          `${name}: wanted field '${key}', the ${pointer.source} secret has {${had}}`,
        )
      }
      setSessionEntry(session.vars, name, withValue(records.get(name) as ShellVar, value))
    }
  }
}
