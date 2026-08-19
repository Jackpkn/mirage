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

import { renderDeny, renderPending } from '../../policy/index.ts'
import type { CommandContext } from '../../policy/index.ts'
import { parsedCommands } from '../../runtime/policy/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import { CycleError, resolvePath } from '../../utils/path.ts'
import { toScope } from '../executor/builtins/scope.ts'
import { followPaths } from '../executor/builtins/links/links.ts'
import { pathFlagScopes, positionalScopes, programTokens } from '../executor/command/routing.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { SLASH_KEEPS_LAST, commandVisible, followsLastComponent, isTool } from '../route/index.ts'
import type { Session } from '../session/session.ts'

/**
 * What the command plane prints when a line does not get to run: 127
 * for a word the session cannot see, 126 for a whole-command refusal
 * or an unanswered ask, the operand code (1, tar 2) for an
 * operand-scoped refusal. Mirrors the Python `Refusal`.
 */
export interface Refusal {
  readonly stderr: Uint8Array
  readonly exitCode: number
}

/**
 * The paths a path-pattern guard reads for a line: the operands as
 * typed and the values of path-valued flags, then, for a command that
 * follows links, the targets they resolve to. `cat /data/link` reads
 * `/data/secret`, so a rule protecting the target has to see it, and a
 * command-scoped rule never runs at the op door where the resolved path
 * would otherwise be checked. The follow policy is the command's own
 * (`followsLastComponent`: rm, mv, ln, stat, tar ... act on the link
 * itself, `-L` turns following back on), the same one the router
 * applies to the operands before the handler runs, so a rule sees
 * exactly the path the command will touch. A loop is left to that later
 * step to report; here the typed paths stand.
 */
export function policyScopes(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  namespace: Namespace | null,
  cwd: string,
): PathSpec[] {
  const scopes: PathSpec[] = []
  for (const p of operands) {
    if (p instanceof PathSpec) scopes.push(p)
  }
  scopes.push(...pathFlagScopes(name, [...args], cwd))
  if (name.includes('/')) {
    // A slash-carrying head word is a file the line executes, and it
    // lives in argv[0], not the operands, so a path-pattern guard would
    // never see it without this row.
    scopes.unshift(toScope(resolvePath(name, cwd)))
  }
  if (namespace === null || namespace.nodes.size === 0 || operands.length === 0) return scopes
  let followed: (string | PathSpec)[]
  try {
    followed = followPaths(
      namespace,
      [...operands],
      followsLastComponent(name, [name, ...args]),
      !SLASH_KEEPS_LAST.has(name),
    )
  } catch (err) {
    if (err instanceof CycleError) return scopes
    throw err
  }
  const seen = new Set(scopes.map((p) => p.virtual))
  for (const item of followed) {
    if (item instanceof PathSpec && !seen.has(item.virtual)) {
      seen.add(item.virtual)
      scopes.push(item)
    }
  }
  return scopes
}

/**
 * The command plane's admission of one command: visibility, then the
 * policy chain, then the approval door. The one gate every command
 * class passes through, in the tree (`runArgv`, once the words are
 * expanded) and for a line a runtime takes whole (`admitLine`, per
 * parsed command). A word the session's allow lists do not install is
 * bash's "command not found" before any admission hook, so an unlisted
 * tool never leaks a deny reason; a Deny renders in the outcome table's
 * voice; an Ask is answered by the door from the session's grants or
 * the host.
 */
export async function admit(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
): Promise<Refusal | null> {
  if (!commandVisible(name, session)) {
    return { stderr: new TextEncoder().encode(`${name}: command not found\n`), exitCode: 127 }
  }
  const [tokens, program] = programTokens(registry, name, [...args], session.cwd)
  const ctx: CommandContext = {
    command: name,
    paths: policyScopes(name, args, operands, namespace, session.cwd),
    operands: positionalScopes(name, [...args], session.cwd, [...operands]),
    argv: [...args],
    cwd: session.cwd,
    registry,
    sessionId: session.sessionId,
    tokens,
    program,
    tool: isTool(name, session),
  }
  const asked = await registry.policies.preCommand(ctx)
  // An Ask is the chain's answer only after every Deny had its say; the
  // door answers it from the session's grants or the host, so a grant
  // never re-opens a deny.
  const verdict =
    asked !== null && asked.kind === 'ask' ? await registry.approvals.resolve(ctx, asked) : asked
  if (verdict === null) return null
  const [stderr, exitCode] =
    verdict.kind === 'pending' ? renderPending(name, verdict) : renderDeny(name, verdict)
  return { stderr, exitCode }
}

/**
 * Admit every command of a line a runtime takes whole. A whole line is
 * a command like any other: the runtime does the expanding, so each
 * parsed command is admitted on its literal words, classified as typed
 * (a path-shaped word is a path, an installed CLI's verb path is
 * walked), and the first refusal is the line's. A word the gate cannot
 * read (`$cmd`) is a word no allow list covers, which fails toward
 * refusal.
 */
export async function admitLine(
  root: TSNodeLike,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
): Promise<Refusal | null> {
  for (const parsed of parsedCommands(root, registry.clis.names())) {
    const args = parsed.words.slice(1)
    const classified = classifyParts([parsed.command, ...args], registry, session.cwd)
    const refusal = await admit(
      parsed.command,
      args,
      classified.slice(1),
      session,
      registry,
      namespace,
    )
    if (refusal !== null) return refusal
  }
  return null
}
