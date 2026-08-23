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
import {
  Admitted,
  admit,
  classifiedWords,
  gate,
  redirectPaths,
  statementRedirects,
  type Refusal,
} from './admission.ts'
import { innerLines, innerReadable, wordValue, type Word } from './inner_lines.ts'

const DECODER = new TextDecoder()

/**
 * Nodes that run their commands in a child shell: a `cd` inside one
 * applies to the rest of that child and is gone when it exits. A
 * pipeline is not here because it forks per segment, not once.
 */
const FORK_SCOPES: ReadonlySet<string> = new Set([
  NodeType.SUBSHELL,
  NodeType.COMMAND_SUBSTITUTION,
  NodeType.PROCESS_SUBSTITUTION,
])

type WalkItem = [Word[], Word[], Session]

/**
 * A walk yields each command and returns the session its scope ends in,
 * which is how a `cd` reaches the commands after it without escaping the
 * child shell it ran in.
 */
type Walk = Generator<WalkItem, Session>

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

/**
 * Explain one command and whatever lines it runs in turn.
 *
 * The redirect targets are read as words of the command, exactly as
 * admission reads them: the shell opens them on its own fds, outside the
 * window the command's own gate covers, so a rule about `/protected`
 * sees `echo x > /protected` only if they are passed here. Omitting them
 * made the dry run answer ALLOW for a line the run then refused. They
 * are empty for a command with none and for the inner lines a command
 * runs, which admission reads the same way.
 */
export async function explainWords(
  words: readonly Word[],
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
  redirectWords: readonly Word[] = [],
): Promise<Explanation[]> {
  const head = words[0]
  if (head === undefined) return []
  if (head.text === null) return [unreadableWord(head.raw)]
  const name = wordValue(head)
  const args = words.slice(1).map(wordValue)
  const classified = classifiedWords(name, args, session, registry)
  const gated = await gate(
    name,
    args,
    classified.slice(1),
    session,
    registry,
    namespace,
    agentId,
    null,
    redirectPaths(redirectWords, registry, session.cwd),
  )
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

/** One command node's words, name first, the env prefix dropped. */
function wordsOf(node: TSNodeLike, home: string | null): Word[] {
  const [, parts] = splitEnvPrefix(getParts(node))
  return parts.map((part) => ({ raw: getText(part), text: literalWord(part, home) }))
}

/**
 * Every command under one node, in source order, each with the session
 * it is judged in; returns the session the node leaves behind.
 *
 * A `cd` reaches the commands after it, and how far is the whole
 * question. Pinned against bash: `( )`, `$( )` and `<( )` run their
 * contents in a child shell, so a `cd` inside one applies to the rest of
 * that child and is gone when it exits; a pipeline forks once per
 * segment, so a `cd` in one segment reaches neither the next segment nor
 * the line; `&` backgrounds into a fork; and a brace group or an `if`
 * body does not fork at all, so its `cd` does escape. Reading a subshell
 * as "no `cd` applies" rather than "no `cd` escapes" judged
 * `(cd d && tar -c ..)` at the wrong directory, which made `..` read as
 * a mount root.
 *
 * The session is returned rather than carried down because that is what
 * "escapes" means, and because `&` is not a wrapper node: it is a token
 * following its command, visible only to whoever holds the sibling list.
 */
function* walkNode(node: TSNodeLike, session: Session, home: string | null): Walk {
  if (node.type === NodeType.COMMAND) {
    let walked = session
    const words = wordsOf(node, home)
    if (words.length > 0) {
      yield [words, statementRedirects(node, home), session]
      walked = afterCd(words, session)
    }
    // A substitution among the words runs in its own shell.
    for (const child of node.children) yield* walkNode(child, session, home)
    return walked
  }
  if (FORK_SCOPES.has(node.type)) {
    yield* walkChildren(node, session, home)
    return session
  }
  if (node.type === NodeType.PIPELINE) {
    for (const child of node.children) yield* walkNode(child, session, home)
    return session
  }
  return yield* walkChildren(node, session, home)
}

/**
 * One scope's children in order, threading the cwd between them; returns
 * the session the scope ends in.
 */
function* walkChildren(node: TSNodeLike, session: Session, home: string | null): Walk {
  let walked = session
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child === undefined) continue
    const ended = yield* walkNode(child, walked, home)
    if (children[index + 1]?.type === '&') continue
    walked = ended
  }
  return walked
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
 * or `explain` would report an allow the run then refuses. The redirects
 * ride along for the same reason: they are read here so both readers
 * judge the file the shell opens, not just the operands.
 */
function* walkedLine(root: TSNodeLike, session: Session): Generator<WalkItem> {
  yield* walkNode(root, session, homeDir(session))
}

/**
 * Whether an explanation refuses the line's intent, rather than just
 * failing one command.
 *
 * A rule that named itself is a verdict. So is a refusal the document
 * said nothing about: a coded policy answers on its own account, and
 * with no permissions document there is no rule for it to point at, so
 * reading "no rule" as "no verdict" made every coded policy invisible to
 * the pass. What stays out is the rule-less DENY: a head word the
 * session cannot see, a line no allow entry covers, and a word only the
 * runtime can expand, each of which is answered where it happens rather
 * than against the whole line.
 */
function isVerdict(expl: Explanation): boolean {
  if (expl.exitCode === 0) return false
  return expl.rule !== null || expl.outcome === Outcome.ALLOW
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
 * records no request; a command it refuses on is then put through the
 * real gate, which is where an ask is recorded, exactly once, for a line
 * that will not run.
 *
 * Every command is judged whether or not the session carries a document.
 * A coded policy refuses on its own account, and one is always
 * registered (`MountRootPolicy`), so returning early on a session with
 * no rules held the line for a document and let a policy keep the
 * half-line behavior the pass exists to remove.
 *
 * A line with one command to judge is left to the per-command gate,
 * which is not an optimization but the more faithful answer: there is no
 * earlier command whose side effects a hold could save, and the gate
 * refuses from inside the shell, so the line's own redirections still
 * apply. This pass answers above them, so refusing `rm -rf /mnt 2>&1`
 * here wrote the refusal to stderr where bash puts it on stdout.
 */
export async function prejudgeLine(
  root: TSNodeLike,
  session: Session,
  registry: MountRegistry,
  namespace: Namespace | null,
  agentId: string,
  reparse: (line: string) => TSNodeLike,
  // This pass puts real questions to a host, so it carries the run's
  // kill channel exactly as the per-command gate does. Without it a
  // compound line asked here waited on an answer that its own timeout
  // could no longer cut short.
  signal?: AbortSignal,
): Promise<Refusal | null> {
  const judged: [Word[], Session, Explanation[]][] = []
  for (const [words, redirects, walked] of walkedLine(root, session)) {
    if (words[0]?.text === null) continue
    judged.push([
      redirects,
      walked,
      await explainWords(words, walked, registry, namespace, agentId, reparse, redirects),
    ])
  }
  if (judged.reduce((n, [, , explained]) => n + explained.length, 0) < 2) return null
  for (const [redirects, walked, explained] of judged) {
    const targets = redirectPaths(redirects, registry, walked.cwd)
    for (const [index, expl] of explained.entries()) {
      if (!isVerdict(expl)) continue
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
        null,
        // explainWords lists the statement's own command first and the
        // lines it runs after it, so only the first explanation is the
        // command the redirects belong to.
        index === 0 ? targets : [],
        signal,
      )
      if (!(answered instanceof Admitted)) return answered
      // The host answered this one inline. The rest of the line has not
      // been judged yet, so the scan goes on: stopping here let a later
      // command's deny run behind an approval.
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
  for (const [words, redirects, walked] of walkedLine(root, session)) {
    out.push(
      ...(await explainWords(words, walked, registry, namespace, agentId, reparse, redirects)),
    )
  }
  return out
}
