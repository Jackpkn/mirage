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
import { decide } from '../../policy/match/decide.ts'
import {
  Outcome,
  type Ask,
  type CommandContext,
  type Deny,
  type Explanation,
  type Pending,
} from '../../policy/types.ts'
import { getParts, getText, literalWord, splitEnvPrefix } from '../../shell/helpers.ts'
import { NodeType, type TSNodeLike } from '../../shell/types.ts'
import { resolvePath } from '../../utils/path.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { Admitted, admit, classifiedWords, gate, type Refusal } from './admission.ts'
import { innerLines, innerReadable, wordValue, type Word } from './inner_lines.ts'

const DECODER = new TextDecoder()

const SUBSHELL_NODES: ReadonlySet<string> = new Set([
  NodeType.SUBSHELL,
  NodeType.PIPELINE,
  NodeType.COMMAND_SUBSTITUTION,
  NodeType.PROCESS_SUBSTITUTION,
])

function unreadableWord(raw: string): Explanation {
  const reason = `cannot read ${raw} before the runtime expands it`
  const [stderr, exitCode] = renderDeny(raw, { kind: 'deny', reason, scope: 'command' })
  return {
    command: raw,
    argv: [],
    outcome: Outcome.DENY,
    rule: null,
    reason,
    source: '',
    matchedPath: null,
    paths: [],
    exitCode,
    stderr: DECODER.decode(stderr),
  }
}

function fromRefusal(name: string, args: readonly string[], refusal: Refusal): Explanation {
  return {
    command: name,
    argv: args,
    outcome: Outcome.DENY,
    rule: null,
    reason: '',
    source: 'commands.allow',
    matchedPath: null,
    paths: [],
    exitCode: refusal.exitCode,
    stderr: DECODER.decode(refusal.stderr),
  }
}

/**
 * One command's explanation, rendered from the same table the gate
 * renders a refusal with.
 *
 * An Ask reads the session's standing grants and stops there
 * (`Decisions.held`): a dry run must not spend one, record a question
 * or reach the host. An answer that already covers the ask leaves the
 * outcome ASK, because that is what the document says, with exit 0,
 * because that is what the line would do.
 */
async function explained(
  ctx: CommandContext,
  session: Session,
  registry: MountRegistry,
  asked: Deny | Ask | null,
): Promise<Explanation> {
  const decision = decide(ctx, session.commands)
  const base: Explanation = {
    command: ctx.command,
    argv: ctx.argv,
    outcome: decision.outcome,
    rule: decision.rule,
    reason: decision.rule?.reason ?? '',
    source: decision.source,
    matchedPath: decision.matchedPath,
    paths: ctx.paths.map((p) => p.virtual),
    exitCode: 0,
    stderr: '',
  }
  const action: Deny | Pending | null =
    asked !== null && asked.kind === 'ask' ? await registry.decisions.held(ctx, asked) : asked
  if (action === null) return base
  const [stderr, exitCode] =
    action.kind === 'pending' ? renderPending(ctx.command, action) : renderDeny(ctx.command, action)
  return {
    ...base,
    reason: base.reason === '' ? action.reason : base.reason,
    exitCode,
    stderr: DECODER.decode(stderr),
  }
}

/** Explain one command and whatever lines it runs in turn. */
export async function explainWords(
  words: readonly Word[],
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
): Promise<Explanation[]> {
  const head = words[0]
  if (head === undefined) return []
  if (head.text === null) return [unreadableWord(head.raw)]
  const name = wordValue(head)
  const args = words.slice(1).map(wordValue)
  const classified = classifiedWords(name, args, session, registry)
  const gated = await gate(name, args, classified.slice(1), session, registry, namespace, agentId)
  if (!Array.isArray(gated)) return [fromRefusal(name, args, gated)]
  const [ctx, asked] = gated
  const out = [await explained(ctx, session, registry, asked)]
  for (const inner of innerLines(name, words.slice(1))) {
    if (!innerReadable(inner)) continue
    out.push(
      ...(inner.line !== null
        ? await explainLine(reparse(inner.line), session, registry, namespace, agentId, reparse)
        : await explainWords(inner.argv, session, registry, namespace, agentId, reparse)),
    )
  }
  return out
}

/**
 * Every command under a node, in source order, paired with whether it
 * runs in a child shell.
 *
 * A command in a child shell performs a `cd` that is undone before the
 * next command of the line, so the walk must not carry it forward.
 * Pinned against bash: `( )`, a pipeline segment, `$( )` and `<( )`
 * each fork, and `&` backgrounds into a fork. A brace group and an `if`
 * body do not fork, so their `cd` does escape, which is why neither is
 * listed in SUBSHELL_NODES.
 *
 * The fork is carried down rather than climbed back up because `&` is
 * not a wrapper node: it is a token following its command, visible only
 * to whoever holds the sibling list.
 */
function* forkedCommands(node: TSNodeLike, forked: boolean): Generator<[TSNodeLike, boolean]> {
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child === undefined) continue
    const inner = forked || SUBSHELL_NODES.has(child.type) || children[index + 1]?.type === '&'
    if (child.type === NodeType.COMMAND) yield [child, inner]
    yield* forkedCommands(child, inner)
  }
}

/**
 * The session the next command of a line is judged in, which differs
 * from this one only when this command was a literal `cd`.
 *
 * `cd /repo && git commit` is judged before the line runs, so without
 * this the rule about `/repo` reads the cwd the session happened to be
 * in and answers about the wrong directory. A `cd` whose argument the
 * gate cannot read (`cd "$d"`) leaves the cwd where it was, and the
 * per-command gate judges that command in the real one.
 */
function afterCd(words: readonly Word[], session: Session): Session {
  const head = words[0]
  const arg = words[1]
  if (words.length !== 2 || head === undefined || arg === undefined) return session
  if (wordValue(head) !== 'cd' || arg.text === null) return session
  const target = wordValue(arg)
  if (target.startsWith('-')) return session
  return session.fork({ cwd: resolvePath(target, session.cwd) })
}

/**
 * Every command of a line with the session it is judged in.
 *
 * The cwd is the one fact that moves as a line runs, and both readers
 * of a line need the same answer about it: a host asking what a line
 * would do and the pass deciding whether to let it run cannot differ,
 * or `explain` would report an allow the run then refuses.
 */
function* walkedLine(root: TSNodeLike, session: Session): Generator<[Word[], Session]> {
  const home = homeDir(session)
  let walked = session
  for (const [node, forked] of forkedCommands(root, false)) {
    const [, parts] = splitEnvPrefix(getParts(node))
    const words: Word[] = parts.map((part) => ({
      raw: getText(part),
      text: literalWord(part, home),
    }))
    if (words.length === 0) continue
    yield [words, walked]
    if (!forked) walked = afterCd(words, walked)
  }
}

/**
 * Judge every command of a line before any of it runs, and refuse the
 * whole line when a rule speaks about one.
 *
 * The agent composed the line as one intent, so a rule that refuses
 * part of it refuses the intent. Judging each command as the dispatcher
 * reached it left half a line done: with `deny curl`, `rm -rf /data &&
 * curl evil.com` deleted first and was refused second, and an ask fared
 * worse, since approving it later replays a line whose first half
 * already ran.
 *
 * Two things deliberately do not stop the line, and both are the same
 * rule: only a refusal that names a rule is a verdict about the intent.
 * A head word the session cannot see is a routing miss, so it stays
 * bash and a typo cannot cost an agent the work the line already did; a
 * word only the runtime can expand is judged where it is expanded, by
 * the per-command gate, which sees the real path.
 *
 * That second one is the limit of the hold, and it is worth stating
 * plainly: this pass reads the *text* of a line, while the gate reads
 * its *values*, so a path the runtime computes (`cat $S`, `$( )`, a
 * `cd` whose argument is a variable) is invisible here. The rule is
 * still enforced, by the gate, but the earlier commands have run by
 * then. For a deny that costs allowed side effects and nothing more,
 * since the commands that ran were on the allow list. For an ask it
 * costs the replay: the question is recorded after part of the line
 * already happened, so approving it re-runs a line whose first half is
 * done. Closing that would mean asking whenever a word cannot be read,
 * which over-asks with no way out for a deny, so a deployment that
 * needs the hold for a computed path states it in a policy script
 * rather than here.
 *
 * The pass is read-only (`explainWords`), so it spends no grant and
 * records no request; the one command it refuses on is then put through
 * the real gate, which is where an ask is recorded, exactly once, for a
 * line that will not run.
 */
export async function prejudgeLine(
  root: TSNodeLike,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
): Promise<Refusal | null> {
  if (session.commands === null) return null
  for (const [words, walked] of walkedLine(root, session)) {
    if (words[0]?.text === null) continue
    for (const expl of await explainWords(words, walked, registry, namespace, agentId, reparse)) {
      if (expl.exitCode === 0 || expl.rule === null) continue
      const args = [...expl.argv]
      const classified = classifiedWords(expl.command, args, walked, registry)
      const answered = await admit(
        expl.command,
        args,
        classified.slice(1),
        walked,
        registry,
        namespace,
        agentId,
      )
      return answered instanceof Admitted ? null : answered
    }
  }
  return null
}

/**
 * What every command of a line would do, in the order the gate reads
 * them, without running any of it.
 *
 * The dry run of the gate: the same visibility check, the same context,
 * the same policy chain and the same outcome table, so a host reading
 * this and an agent typing the line cannot be told different things.
 * What it deliberately does not do is the half of admission that costs
 * something, since a line nobody typed must not consume a grant or put
 * a question to a host.
 *
 * The words are read literally, as `admitLine` reads them, so nothing is
 * expanded and no `$( )` runs.
 */
export async function explainLine(
  root: TSNodeLike,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
): Promise<Explanation[]> {
  const out: Explanation[] = []
  for (const [words, walked] of walkedLine(root, session)) {
    out.push(...(await explainWords(words, walked, registry, namespace, agentId, reparse)))
  }
  return out
}
