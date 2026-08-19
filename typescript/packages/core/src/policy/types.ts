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

import type { Limit, PathSpec, Producer } from '../types.ts'

/**
 * The one registry question policy hooks may ask. MountRegistry
 * satisfies this structurally; the narrow interface keeps this package
 * a leaf (no workspace imports), so the registry can host a Policies
 * instance without a cycle. Mirrors the Python MountRootQuery.
 */
interface MountRootQuery {
  isMountRoot(path: string): boolean
}

/**
 * What a command-plane refusal is about, which picks its voice. `command`
 * refuses the whole line: `<cmd>: policy denied: <reason>`, exit 126.
 * `operand` refuses one operand and keeps the GNU voice `<cmd>: <reason>`
 * (the reason names the operand, as `rm: cannot remove 'x': ...` does),
 * exit 1, or the command's own fatal code where GNU differs (tar exits
 * 2). The exit code and errno derive from the plane and this scope,
 * never from a number a policy picks, so a document deny and a coded
 * one are indistinguishable. Mirrors the Python DenyScope.
 */
export type DenyScope = 'command' | 'operand'

/**
 * Refuse the command, op or session write, with a reason. Rendered by
 * the door it fires at: the command plane prints it in the scope's voice
 * (DenyScope), the op doors throw EACCES with it, the session door
 * EACCES too. `kind` is the wire discriminant shared with Python.
 */
export interface Deny {
  kind: 'deny'
  /** Why, without the command name and without a trailing newline; the door adds both. */
  reason: string
  /** Whole command (the default) or one operand; ignored off the command plane. */
  scope?: DenyScope
}

/**
 * One admission rule of the permissions document: refuse (or ask about)
 * matching commands, on matching paths when it names any. It is the
 * compiled element of `commands.deny` and `commands.ask` at every tier
 * and reaches the workspace only inside that document; the internal
 * RulePolicy is what evaluates it. The document writes a rule in one of
 * three shapes, and each compiles to rules of this shape: a list of
 * command patterns (a whole-line rule on each, no paths), a mapping of
 * command pattern to its paths (one command to many paths, one rule per
 * command, so a path is never stated beside a command it was not meant
 * for), or paths alone (a rule on every command, at the op door too). A
 * command entry is a token-prefix pattern over the line as the door
 * normalizes it (`rm` is every rm line, `git push` every `git push ...`,
 * a `*` token any one token). Path entries use the document's one
 * grammar: an entry with `*`, `?` or `[` is a pattern (repo fnmatch
 * dialect, `*` crossing `/`, a slashless pattern matching any name
 * component), anything else is an exact path and its subtree. An entry
 * holds a token (a blank one would be the root), and at the workspace
 * and profile tiers it is absolute or a name pattern; only the mount
 * tier's entries are relative, to the mount root. Empty
 * `commands` means every command, and a path-scoped rule carries exactly
 * one; empty `paths` refuses the command regardless of its operands.
 * `mount` is set by the compiler for a mount-tier rule (the mount root
 * the rule is scoped to: it applies only to a line whose cwd or paths
 * lie under it), never typed.
 */
export interface CommandRule {
  reason: string
  commands?: readonly string[]
  paths?: readonly string[]
  mount?: string
}

/**
 * Admit the command only with a host approval. A preCommand answer:
 * `PermissionsPolicy` returns one for a `commands.ask` rule, a custom
 * policy for a coded condition, and both route to the workspace's
 * approval door (`Approvals`). A Deny from any policy outranks it: the
 * chain keeps looking past an Ask for a Deny, so an approval can never
 * re-open a refusal. Command plane only: the op doors cannot wait on a
 * host. `rule` is the document rule that asked, absent for a coded
 * condition, for which the door keys a session grant on the program
 * that asked. Mirrors the Python Ask.
 */
export interface Ask {
  kind: 'ask'
  /** Why the line needs sign-off, shown to the agent and the host. */
  reason: string
  rule?: CommandRule
}

/**
 * The closed vocabulary of policy answers: a hook returns an Action to
 * state an opinion or null to stay silent. Deny refuses (first opinion
 * wins); Ask defers to the host (a Deny anywhere in the chain still
 * wins); Limit bounds (every opinion merges to the tightest,
 * Limit.aggr). Each hook accepts a fixed set of kinds (VALIDITY),
 * enforced at the seam.
 */
export type Action = Deny | Limit | Ask

/**
 * The host's answer to an approval request. `allow_once` admits the
 * exact line one time, `allow_session` admits every line the rule
 * covers for the rest of the session, `deny` refuses the retry with the
 * ask's reason in the deny voice.
 */
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny'

/**
 * How far a host grant reaches through `Approvals.grant`: `once` is
 * `allow_once`, `session` is `allow_session`.
 */
export type GrantScope = 'once' | 'session'

/**
 * The host's standing answer to an asked line, held on the session until
 * the run it answers. `allow_once` and `deny` answer one retry of the
 * exact line (the expanded words and the cwd of the request) and are
 * consumed by it; `allow_session` answers every line the rule covers for
 * the rest of the session and stays. Session state like functions and
 * cwd: persisted with the session record, read through the session
 * manager so a fork or a background copy shares it, never inherited by
 * another session. Consulted only after the deny arm, so a grant never
 * re-opens a deny. `argv` is the line as expanded, command name first.
 * Mirrors the Python Grant.
 */
export interface Grant {
  decision: ApprovalDecision
  /** The rule the answer is for; for a coded Ask the door synthesizes one over the program that asked. */
  rule: CommandRule
  argv: readonly string[]
  cwd: string
}

/**
 * One asked line, as the approver sees it. `id` is stable for the exact
 * line in the session (a digest of session, cwd and words), so a retry
 * asks the same question and the host answers it once. `argv` is the
 * words after the name, as expanded; `paths` the virtual paths the line
 * names; `rule` the rule that asked (synthesized for a coded Ask).
 * Mirrors the Python ApprovalRequest.
 */
export interface ApprovalRequest {
  id: string
  sessionId: string
  agentId: string
  command: string
  argv: readonly string[]
  cwd: string
  paths: readonly string[]
  reason: string
  rule: CommandRule
}

/**
 * The door's answer while the host has not decided: the line is refused
 * for now, and the id names what to grant. Mirrors the Python Pending.
 */
export interface Pending {
  kind: 'pending'
  id: string
  reason: string
}

/**
 * The session questions the approval door asks. The SessionManager
 * satisfies it structurally, so the door reads and writes a session's
 * grants by id without this package importing the workspace, and always
 * on the registered session rather than the fork a line may be running
 * in. Mirrors the Python SessionGrantsQuery.
 */
export interface SessionGrantsQuery {
  grantsOf(sessionId: string): readonly Grant[]
  setGrants(sessionId: string, grants: readonly Grant[]): void
  flush(): Promise<void>
}

/**
 * One tier's `commands` block, compiled. A session is evaluated over an
 * array of these: the mount tiers in registration order, the workspace
 * tier, then the session's own (profile tightened by the inline
 * document). `allow` intersects across tiers (a line must match one
 * pattern in every tier that has a list), `ask` and `deny` union, in
 * tier order for the message. `allow` null when the tier states no list.
 */
export interface CommandsSpec {
  allow: readonly string[] | null
  ask: readonly CommandRule[]
  deny: readonly CommandRule[]
}

/**
 * The one session question the permissions policy asks. The
 * SessionManager satisfies it structurally, so the policy reads the
 * layers by session id without this package importing the workspace.
 * An id the manager does not know (or the empty id of an unbound door)
 * answers the bound tiers alone, so it still fails toward refusal.
 */
export interface SessionCommandsQuery {
  commandsOf(sessionId: string): readonly CommandsSpec[]
}

/** Facts about one classified command, as preCommand hooks see it. */
export interface CommandContext {
  command: string
  /**
   * Every path the line names: the positional operands first, then the
   * values of any path-valued flags. What a path-pattern guard matches on.
   */
  paths: readonly PathSpec[]
  /**
   * The positional operands alone. A rule that reads a slot by position
   * (mv's source, ln's target, tar's files) has to use this: with the flag
   * values mixed in, `tar -xf a.tar -C /mnt` would read the `-C`
   * destination as a file being archived.
   */
  operands?: readonly PathSpec[]
  /** Raw argv after the command name; hooks fire before flag parsing. */
  argv: readonly string[]
  cwd: string
  registry: MountRootQuery
  /** The session running the line, set by the door; empty outside a workspace. */
  sessionId?: string
  /**
   * The agent the workspace attributes the line to, carried per
   * execution so a nested line (`eval`, `$()`, `xargs`) and a
   * concurrent one keep their own; what an approval request names.
   */
  agentId?: string
  /**
   * The line as an admission pattern reads it, command name first: for
   * an installed CLI the verb path replaces the words before it (options
   * before the verb dropped, an alias canonicalized), then the leaf's
   * own words; for anything else the name and the raw argv.
   */
  tokens?: readonly string[]
  /** The head of `tokens` that names what runs: the name plus a CLI's verb path. */
  program?: readonly string[]
  /**
   * Whether the word is a tool the allow lists govern. The door clears
   * it for the shell's own grammar (the grammar-tier builtins), the
   * agent's own function where the function is what runs, and an
   * executed path: none of those is tool use, so an allow list never
   * refuses them, though a deny rule still can. Absent reads as true.
   */
  tool?: boolean
}

/** Facts about one VFS op, as preOps hooks see it. Fires at the op
 * door (the dispatcher every access routes through, FUSE included),
 * before any backend or cache I/O. `sessionId` is the session the door
 * serves, set from the session it already resolves for hides and
 * modes; empty for the unbound host view. */
export interface OpsContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
  sessionId?: string
}

/** One completed VFS op, as postOps hooks see it; a Deny suppresses
 * the result. */
export interface OpsResultContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
  result: unknown
}

/**
 * One finished execute() line, as postExecute hooks see it. Fires at
 * the workspace boundary before the line's output stream is
 * finalized, so a Limit returned here bounds what the caller sees.
 * `producer` is the provenance of the surviving stream (the rightmost
 * command, per shell semantics), with an empty command when no
 * dispatch site stamped one.
 */
export interface ExecuteResultContext {
  producer: Producer
  exitCode: number
}

/**
 * Facts about one session-state mutation, as preSession hooks see it.
 * Fires on the session plane before the write lands, so it holds
 * whichever tier asked. Not an OpsContext: a session key is not a
 * path, and a path-scoped policy must never receive one dressed as a
 * path and match it by accident. `value` is null for an unset.
 * `sessionId` says which session is writing, so a policy can scope a
 * rule to one agent (deny `set` for session X).
 */
export interface SessionContext {
  plane: string
  verb: string
  key: string
  value: string | null
  sessionId: string
}

export const VALIDITY: Readonly<
  Record<'preCommand' | 'preOps' | 'postOps' | 'postExecute' | 'preSession', ReadonlySet<string>>
> = {
  preCommand: new Set(['deny', 'ask']),
  preOps: new Set(['deny']),
  postOps: new Set(['deny', 'limit']),
  postExecute: new Set(['limit']),
  preSession: new Set(['deny']),
}
