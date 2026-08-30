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

import { invokedEnvNames } from '../../commands/cli/walk.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { VFSRuntime } from '../../runtime/table.ts'
import { SecretsError } from '../../secrets/errors.ts'
import { fetchSecret } from '../../secrets/registry.ts'
import { SHOPT_DEFAULTS } from '../../shell/constants.ts'
import {
  commandInvocations,
  commandWords,
  envReads,
  opaqueReads,
  referencedNames,
} from '../../shell/parse.ts'
import type { ManagedRef, ShellVar } from '../../shell/variable.ts'
import { withValue } from '../../shell/variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { varHidden } from '../../utils/hidden.ts'
import { lookup } from '../lookup/lookup.ts'
import { Consumer } from '../lookup/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { setSessionEntry, type Session } from '../session/session.ts'
import { deref } from '../session/state.ts'

// Appended to an alias value before parsing it for the read walk: the
// rest of the invoking line lands there at dispatch, so the trailing
// command's arguments are statically unknowable, never absent.
const ALIAS_REST = ' "$__mirage_alias_rest__"'

/** Function bodies the line itself defines, by name. */
function definedBodies(node: TSNodeLike): Map<string, TSNodeLike> {
  const out = new Map<string, TSNodeLike>()
  const stack: TSNodeLike[] = [node]
  for (;;) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName?.('name') ?? null
      const body = current.childForFieldName?.('body') ?? null
      if (nameNode !== null && nameNode.text !== '' && body !== null) {
        out.set(nameNode.text, body)
      }
    }
    stack.push(...current.namedChildren)
  }
  return out
}

/**
 * The line's tree plus every body its command words can run.
 *
 * A body runs at invocation, not where it is defined, so the read
 * walks skip definition subtrees; this is where an invoked body joins
 * back in. A command word pulls in every body it could select, all of
 * them rather than the likeliest: the session's stored function AND
 * the line's own redefinition (`f; f() { :; }` runs the stored body
 * first, so neither may shadow the other), and a stored alias's
 * expansion, reparsed here because dispatch reparses it after this
 * pass has already run. Alias values join only under `expand_aliases`,
 * the same gate alias expansion applies at dispatch. Each name
 * resolves once, so mutual recursion terminates; over-selection only
 * ever over-fetches, under-selection is the bug.
 */
export function lineNodes(
  node: TSNodeLike,
  session: Session,
  reparse: (line: string) => TSNodeLike,
): TSNodeLike[] {
  const defined = definedBodies(node)
  const expand = session.shopts.expand_aliases ?? SHOPT_DEFAULTS.get('expand_aliases') ?? false
  const nodes: TSNodeLike[] = [node]
  const seen = new Set<string>()
  const frontier: TSNodeLike[] = [node]
  for (;;) {
    const current = frontier.pop()
    if (current === undefined) break
    for (const word of commandWords(current)) {
      if (seen.has(word)) continue
      seen.add(word)
      const stored = Object.hasOwn(session.functions, word) ? session.functions[word] : undefined
      const bodies = Array.isArray(stored) ? [...(stored as TSNodeLike[])] : []
      const local = defined.get(word)
      if (local !== undefined) bodies.push(local)
      const aliased = Object.hasOwn(session.aliases, word) ? session.aliases[word] : undefined
      // An alias is a textual prefix: dispatch appends the
      // invocation's rest to the value, so the value's trailing
      // command is parsed with a dynamic rest-word. That keeps its
      // argument list honest -- a CLI named in an alias reads as
      // "verbs unknowable" (whole spec tree) rather than "no verb
      // selected".
      if (expand && aliased !== undefined) bodies.push(reparse(aliased + ALIAS_REST))
      nodes.push(...bodies)
      frontier.push(...bodies)
    }
  }
  return nodes
}

/**
 * Whether any of the line's commands runs on a guest runtime.
 *
 * A guest receives the exported environment as one snapshot, so every
 * managed name may be read whatever the line spells --
 * `python3 -c 'os.environ[...]'` never writes a `$NAME` the walk could
 * see. The vfs runtime is the executor itself, whose commands read
 * vars one at a time, so it does not count. Keyed on the walked set's
 * own command words (stored function bodies included) because the
 * static table binds every captured command in the workspace, not this
 * line's.
 */
export function guestBound(
  nodes: TSNodeLike[],
  decision: RouteDecision | null,
  staticBindings: Record<string, Runtime | null>,
): boolean {
  const bindings = decision !== null ? decision.bindings : staticBindings
  const words = new Set<string>(['*'])
  for (const node of nodes) {
    for (const word of commandWords(node)) words.add(word)
  }
  for (const word of words) {
    const runtime = Object.hasOwn(bindings, word) ? bindings[word] : undefined
    if (runtime != null && !(runtime instanceof VFSRuntime)) return true
  }
  return false
}

/**
 * Env names the line's installed CLIs are about to read.
 *
 * An installed CLI reads a managed name through `Option.env` with no
 * `$NAME` in the line's text, so the fill set has to be told. A head
 * word counts only when dispatch would actually run the CLI (`lookup`):
 * a function, builtin or namespace command shadowing the name wins
 * routing, and a head the session's profile hides never runs at all.
 * The invocation's literal words then prune the tree
 * (`invokedEnvNames`), so `ntn api get` contributes the api and get
 * chain rather than every sibling verb's options.
 */
export function cliEnvNames(
  nodes: TSNodeLike[],
  session: Session,
  registry: MountRegistry,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const node of nodes) {
    for (const [head, args] of commandInvocations(node)) {
      if (head === null) continue
      const install = registry.clis.get(head)
      if (install === null) continue
      if (lookup(head, session, registry) !== Consumer.CLI) continue
      const words = args.includes(null)
        ? null
        : new Set(args.filter((arg): arg is string => arg !== null && !arg.startsWith('-')))
      for (const name of invokedEnvNames(install.spec, words)) out.add(name)
    }
  }
  return out
}

/**
 * The session's unfetched managed names, hidden ones excluded.
 *
 * A hidden name never fetches at all: the snapshot filters it and
 * expansion reads it as unset, so no fetch could ever be visible.
 */
function pendingOf(session: Session): Map<string, ManagedRef> {
  const out = new Map<string, ManagedRef>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (v.managed === undefined || v.value !== null) continue
    if (varHidden(session.hiddenVars, name)) continue
    out.set(name, v.managed)
  }
  return out
}

/**
 * The pending names the line's walked set is about to read.
 *
 * A whole-environment render, an opaque read (`opaqueReads`), or a
 * command head no static read can spell (`$tool api ...` -- the
 * program that runs is not decidable before expansion, so neither is
 * its read set) selects everything pending; otherwise the set is the
 * walk's references (nameref targets resolved through the session),
 * the printing forms' explicit targets, the routed CLIs' env names,
 * and the eager-marked entries.
 */
function wanted(
  session: Session,
  nodes: TSNodeLike[],
  pending: Map<string, ManagedRef>,
  lineCliEnvNames: ReadonlySet<string>,
): Set<string> {
  const referenced = new Set<string>()
  const printed = new Set<string>()
  for (const node of nodes) {
    const reads = envReads(node)
    if (reads.whole || opaqueReads(node)) return new Set(pending.keys())
    if (commandInvocations(node).some(([head]) => head === null)) {
      return new Set(pending.keys())
    }
    for (const name of reads.names) printed.add(name)
    for (const name of referencedNames(node)) referenced.add(name)
  }
  const out = new Set<string>([...printed, ...lineCliEnvNames])
  for (const [name, ref] of pending) {
    if (ref.eager) out.add(name)
  }
  for (const name of referenced) {
    out.add(name)
    out.add(deref(session, name))
  }
  return new Set([...out].filter((name) => pending.has(name)))
}

/**
 * The managed names one line is about to read, without fetching.
 *
 * Pure planning, split from `fillEnv` so the executor can consult the
 * admission text-pass between deciding and fetching: a line already
 * denied on its literal words never reaches a source.
 */
export function fillNames(
  session: Session,
  nodes: TSNodeLike[],
  whole: boolean,
  lineCliEnvNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const pending = pendingOf(session)
  if (pending.size === 0) return new Set()
  if (whole) return new Set(pending.keys())
  return wanted(session, nodes, pending, lineCliEnvNames)
}

/**
 * Fetch the named managed values into the session.
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
 * SecretsError naming the variable and the source -- never the ref,
 * never any value, and never the source's own words, which go to the
 * host log instead (an SDK error can spell paths or identifiers, and
 * stderr is the agent's to read). The executor folds it into the
 * line's result (exit 1), so a dead source fails exactly the commands
 * that need it.
 */
export async function fillEnv(session: Session, names: ReadonlySet<string>): Promise<void> {
  if (names.size === 0) return
  const pending = pendingOf(session)
  interface Member {
    name: string
    key: string
    record: ShellVar
  }
  const groups = new Map<string, { source: string; ref: string; members: Member[] }>()
  for (const name of [...names].sort(compareCodePoints)) {
    const pointer = pending.get(name)
    const record = Object.hasOwn(session.vars, name) ? session.vars[name] : undefined
    if (pointer === undefined || record === undefined) continue
    const groupKey = JSON.stringify([pointer.source, pointer.ref])
    const member = { name, key: pointer.key, record }
    const group = groups.get(groupKey)
    if (group === undefined) {
      groups.set(groupKey, { source: pointer.source, ref: pointer.ref, members: [member] })
    } else {
      group.members.push(member)
    }
  }
  for (const { source, ref, members } of groups.values()) {
    const listed = members.map((m) => m.name).join(', ')
    let secret
    try {
      secret = await fetchSecret(source, ref)
    } catch (caught) {
      console.warn(`secret fetch for ${listed} from ${source} failed: ${String(caught)}`)
      throw new SecretsError(`${listed}: cannot fetch from ${source}`, { cause: caught })
    }
    for (const { name, key, record } of members) {
      const value = Object.hasOwn(secret.fields, key) ? secret.fields[key] : undefined
      if (value === undefined) {
        const had = Object.keys(secret.fields).sort(compareCodePoints).join(', ')
        throw new SecretsError(`${name}: wanted field '${key}', the ${source} secret has {${had}}`)
      }
      setSessionEntry(session.vars, name, withValue(record, value))
    }
  }
}
