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

import type { ByteSource } from '../../io/types.ts'
import { renderDeny, renderPending } from '../../policy/index.ts'
import type { CommandContext, CommandsSpec } from '../../policy/index.ts'
import { hasRules, readsArgs } from '../../policy/match/reads.ts'
import { commandNodes } from '../../runtime/policy/index.ts'
import { getParts, getText, literalWord, splitEnvPrefix } from '../../shell/helpers.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import { CycleError, resolvePath } from '../../utils/path.ts'
import { toScope } from '../executor/builtins/scope.ts'
import { followPaths } from '../executor/builtins/links/links.ts'
import {
  CWD_DEFAULT_RAW,
  defaultCwdOperand,
  pathFlagScopes,
  positionalScopes,
  programTokens,
} from '../executor/command/routing.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { SLASH_KEEPS_LAST, commandVisible, followsLastComponent, isTool } from '../route/index.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { innerLines, innerReadable, wordValue, type Word } from './inner_lines.ts'

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
 * step to report; here the typed paths stand. Last comes the operand a
 * bare `ls`/`find`/`du`/`tree`/`grep -r` implies, the working directory,
 * which the executor injects after the gate and which a rule on that
 * directory has to see.
 */
export function policyScopes(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  namespace: Namespace | null,
  cwd: string,
  implied: PathSpec | null = null,
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
  if (namespace !== null && namespace.nodes.size > 0 && operands.length > 0) {
    let followed: (string | PathSpec)[] = []
    try {
      followed = followPaths(
        namespace,
        [...operands],
        followsLastComponent(name, [name, ...args]),
        !SLASH_KEEPS_LAST.has(name),
      )
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
    }
    const seen = new Set(scopes.map((p) => p.virtual))
    for (const item of followed) {
      if (item instanceof PathSpec && !seen.has(item.virtual)) {
        seen.add(item.virtual)
        scopes.push(item)
      }
    }
  }
  if (implied !== null && !scopes.some((p) => p.virtual === implied.virtual)) {
    scopes.push(implied)
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
 * the host. `agentId` is the agent the line is attributed to, for an
 * approval request; `stdin` decides whether a bare `rg` reads the
 * working directory.
 */
export async function admit(
  name: string,
  args: readonly string[],
  operands: readonly (string | PathSpec)[],
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId = '',
  stdin: ByteSource | null = null,
): Promise<Refusal | null> {
  if (!commandVisible(name, session)) {
    return { stderr: new TextEncoder().encode(`${name}: command not found\n`), exitCode: 127 }
  }
  const [tokens, program] = programTokens(registry, name, [...args], session.cwd)
  const implied =
    name in CWD_DEFAULT_RAW
      ? defaultCwdOperand([name, ...operands], name, registry, session.cwd, stdin)
      : null
  const ctx: CommandContext = {
    command: name,
    paths: policyScopes(name, args, operands, namespace, session.cwd, implied),
    operands: positionalScopes(name, [...args], session.cwd, [...operands]),
    argv: [...args],
    cwd: session.cwd,
    registry,
    sessionId: session.sessionId,
    agentId,
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

function refuse(name: string, reason: string): Refusal {
  const [stderr, exitCode] = renderDeny(name, { kind: 'deny', reason, scope: 'command' })
  return { stderr, exitCode }
}

function unreadable(raw: string): string {
  return `cannot read ${raw} before the runtime expands it`
}

/**
 * Admit one command of a whole line on the words the gate read, then
 * whatever lines the command runs in turn. `open` says the runtime
 * appends operands the gate cannot read (`xargs`, `find -exec`).
 */
async function admitWords(
  words: readonly Word[],
  open: boolean,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  layers: readonly CommandsSpec[],
  reparse: (line: string) => TSNodeLike,
): Promise<Refusal | null> {
  const head = words[0]
  if (head === undefined) return null
  if (head.text === null && hasRules(layers)) return refuse(head.raw, unreadable(head.raw))
  const name = wordValue(head)
  const args = words.slice(1).map(wordValue)
  const classified = classifyParts([name, ...args], registry, session.cwd)
  const refusal = await admit(
    name,
    args,
    classified.slice(1),
    session,
    registry,
    namespace,
    agentId,
  )
  if (refusal !== null) return refusal
  const unread = words.slice(1).find((w) => w.text === null)?.raw
  if ((unread !== undefined || open) && readsArgs(layers, name)) {
    return refuse(
      name,
      unread !== undefined ? unreadable(unread) : 'runs on operands the gate cannot read',
    )
  }
  for (const inner of innerLines(name, words.slice(1))) {
    if (!innerReadable(inner)) {
      if (hasRules(layers)) return refuse(name, 'runs lines the gate cannot read')
      continue
    }
    const innerRefusal =
      inner.line !== null
        ? await admitLine(reparse(inner.line), session, registry, namespace, agentId, reparse)
        : await admitWords(
            inner.argv,
            inner.open,
            session,
            registry,
            namespace,
            agentId,
            layers,
            reparse,
          )
    if (innerRefusal !== null) return innerRefusal
  }
  return null
}

/**
 * Admit every command of a line a runtime takes whole. A whole line is
 * a command like any other, but the runtime does the expanding, so the
 * gate reads the line as typed: each command is admitted on its literal
 * words (quotes removed, escapes resolved, a path-shaped word a path, an
 * installed CLI's verb path walked), and the first refusal is the
 * line's. A word only the runtime can expand (`$cmd`, `"$p"`, `$(...)`,
 * `{a,b}`) is refused wherever a rule in force would have read it: as
 * the command name whenever the session has any command rule, as an
 * argument when a rule reads that command's arguments (a pattern with a
 * token after the name, a path-scoped or mount-scoped rule). The words
 * that run other words (`eval`, `sh -c`, `xargs`, `env` ... see
 * `innerLines`) have those lines admitted in turn, and a line the gate
 * cannot read at all (a sourced file, a script, `eval "$p"`) is refused
 * under any command rule. With no rule in force nothing is refused on
 * this account: the words are admitted as typed, which is all a coded
 * policy ever saw. `reparse` parses the text a word runs (`eval`,
 * `sh -c`) the way the line reader parsed the line.
 */
export async function admitLine(
  root: TSNodeLike,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
): Promise<Refusal | null> {
  const layers = session.commandLayers
  const home = homeDir(session)
  for (const node of commandNodes(root)) {
    const [, parts] = splitEnvPrefix(getParts(node))
    const words: Word[] = parts.map((part) => ({
      raw: getText(part),
      text: literalWord(part, home),
    }))
    if (words.length === 0) continue
    const refusal = await admitWords(
      words,
      false,
      session,
      registry,
      namespace,
      agentId,
      layers,
      reparse,
    )
    if (refusal !== null) return refusal
  }
  return null
}
