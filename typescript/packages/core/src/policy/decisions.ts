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

import { sha256Hex } from '../utils/hash.ts'
import { Outcome } from './types.ts'
import type {
  Ask,
  CommandContext,
  CommandRule,
  Decision,
  Deny,
  Pending,
  SessionDecisionsQuery,
} from './types.ts'
import { Scope } from './types.ts'

export type AskHandler = (record: Decision) => Promise<Decision | null>

/**
 * The id a record is named by: a digest of what was asked, so a retry
 * of the same line quotes the same id and a host answers it once.
 *
 * The id names the record; it does not decide what a retry matches.
 * That comparison is made against the recorded fields themselves
 * (`covers`), so a line the digest cannot tell apart from another still
 * cannot borrow its answer.
 */
export async function decisionId(
  sessionId: string,
  cwd: string,
  argv: readonly string[],
): Promise<string> {
  const enc = new TextEncoder()
  const parts = [sessionId, cwd, ...argv].map((part) => enc.encode(part + '\0'))
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return (await sha256Hex(bytes)).slice(0, 12)
}

/**
 * The rule an Ask is keyed on: the document's, or for a coded Ask one
 * synthesized over the program that asked, so a session answer reads
 * "stop asking me about this program".
 */
export function askRule(ctx: CommandContext, ask: Ask): CommandRule {
  if (ask.rule != null) return ask.rule
  const program = (ctx.program ?? [ctx.command]).join(' ')
  return { reason: ask.reason, commands: [program] }
}

function sameList(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameRule(a: CommandRule, b: CommandRule): boolean {
  return (
    a.reason === b.reason &&
    a.mount === b.mount &&
    sameList(a.commands, b.commands) &&
    sameList(a.paths, b.paths)
  )
}

function sameLine(record: Decision, argv: readonly string[], cwd: string): boolean {
  const words = [record.command, ...record.argv]
  return (
    record.cwd === cwd && words.length === argv.length && words.every((w, i) => w === argv[i])
  )
}

/**
 * Whether an answered record answers this rule of this line.
 *
 * A ONCE answer covers the exact line it was given for, compared field
 * by field. A SESSION answer covers every line the same rule asks
 * about. Both are keyed on the rule as well as the words: an answer
 * that outlives a rule change (a persisted store reopened under an
 * edited profile) must not answer the new rule's ask, and a stale
 * refusal must not speak in its voice.
 */
export function covers(
  record: Decision,
  rule: CommandRule,
  argv: readonly string[],
  cwd: string,
): boolean {
  if (record.outcome === null || !sameRule(record.rule, rule)) return false
  if (record.scope === Scope.SESSION) return record.outcome === Outcome.ALLOW
  return sameLine(record, argv, cwd)
}

/**
 * The workspace's decision ledger: turns an Ask into run, refuse or
 * pending, and is the host's handle on every question raised and every
 * answer given.
 *
 * One record type, one store. A `Decision` with no outcome is a
 * question waiting; one with an outcome is a question settled, and how
 * far the answer reaches is its `scope`. Keeping both in one place is
 * the point: they used to be two stores, a pending map that vanished on
 * restart and a per-session answer list that did not, so a host could
 * see a question that no longer existed or miss one that did.
 *
 * Mirrors the Python Decisions.
 */
export class Decisions {
  private readonly sessions: SessionDecisionsQuery | null
  private readonly onAsk: AskHandler | null
  private readonly memory = new Map<string, Decision[]>()

  constructor(sessions: SessionDecisionsQuery | null = null, onAsk: AskHandler | null = null) {
    this.sessions = sessions
    this.onAsk = onAsk
  }

  /** Every record, oldest first: questions waiting and questions settled. */
  list(sessionId = ''): Decision[] {
    if (sessionId) return [...this.records(sessionId)]
    return this.keys().flatMap((key) => [...this.records(key)])
  }

  /** The records nobody has answered, oldest first. */
  pending(sessionId = ''): Decision[] {
    return this.list(sessionId).filter((r) => r.outcome === null)
  }

  /**
   * Answer a waiting record, yes or no.
   *
   * ALLOW at ONCE passes the retry of the exact line and is consumed by
   * it; at SESSION it passes every line the rule covers for the rest of
   * the session. DENY refuses the retry in the deny voice, once, and
   * asking again raises a new record.
   */
  async answer(
    decisionId: string,
    outcome: Outcome,
    scope: Scope = Scope.ONCE,
    note = '',
  ): Promise<void> {
    if (outcome === Outcome.ASK) throw new Error('ASK is the question, not an answer')
    for (const key of this.keys()) {
      const records = [...this.records(key)]
      const index = records.findIndex((r) => r.id === decisionId && r.outcome === null)
      if (index === -1) continue
      const record = records[index]
      if (record === undefined) continue
      records[index] = { ...record, outcome, scope, note }
      this.set(key, records)
      await this.flush()
      return
    }
    throw new Error(`no decision waiting with id ${decisionId}`)
  }

  /**
   * The executor's branch for an Ask: settled records answer it, else
   * the question is raised now.
   *
   * Every rule the ask names has to be answered, because each won a
   * subject of its own and a nod covers the subject it was given for.
   * They are asked one at a time, the retry of the line raising the
   * next, and a ONCE answer is only spent once the whole line is
   * answered: spending one while another is still waiting would make
   * the first question come back on every retry.
   */
  async resolve(ctx: CommandContext, ask: Ask): Promise<Deny | Pending | null> {
    const rules = ask.rules ?? [askRule(ctx, ask)]
    const argv = [ctx.command, ...ctx.argv]
    const sessionId = ctx.sessionId ?? ''
    const held = this.records(sessionId)
    const answers = rules.map(
      (rule) => [rule, Decisions.settled(held, rule, argv, ctx.cwd)] as const,
    )
    const spent = answers
      .map(([, r]) => r)
      .filter((r): r is Decision => r !== null && r.scope === Scope.ONCE)
    const refused = answers.find(([, r]) => r !== null && r.outcome === Outcome.DENY)
    if (refused !== undefined) {
      await this.spend(sessionId, spent)
      return { kind: 'deny', reason: refused[0].reason, scope: 'command' }
    }
    for (const [rule, record] of answers) {
      if (record !== null) continue
      const action = await this.raise(ctx, rule, argv)
      if (action !== null) return action
    }
    await this.spend(sessionId, spent)
    return null
  }

  /**
   * What the settled records alone say about an asked line.
   *
   * The read-only half of `resolve`, and the only half a dry run may
   * take: it consults what the session already holds and stops there,
   * spending nothing, recording no question and never reaching the
   * host. So `explain` can report that a line would be refused, or
   * would still be waiting, without a question arriving for a line
   * nobody typed.
   */
  async held(ctx: CommandContext, ask: Ask): Promise<Deny | Pending | null> {
    const argv = [ctx.command, ...ctx.argv]
    const sessionId = ctx.sessionId ?? ''
    const records = this.records(sessionId)
    const answers = (ask.rules ?? [askRule(ctx, ask)]).map(
      (rule) => [rule, Decisions.settled(records, rule, argv, ctx.cwd)] as const,
    )
    const refused = answers.find(([, r]) => r !== null && r.outcome === Outcome.DENY)
    if (refused !== undefined) {
      return { kind: 'deny', reason: refused[0].reason, scope: 'command' }
    }
    const unanswered = answers.find(([, r]) => r === null)
    if (unanswered === undefined) return null
    return {
      kind: 'pending',
      id: await decisionId(ctx.sessionId ?? '', ctx.cwd, argv),
      reason: unanswered[0].reason,
    }
  }

  /**
   * Record one rule of a line as a question and put it to the host,
   * null when the host said yes.
   *
   * A question already waiting is reused rather than duplicated, so a
   * retry keeps quoting one id.
   */
  private async raise(
    ctx: CommandContext,
    rule: CommandRule,
    argv: readonly string[],
  ): Promise<Deny | Pending | null> {
    let record = this.waiting(ctx, rule, argv)
    if (record === null) {
      record = {
        id: await decisionId(ctx.sessionId ?? '', ctx.cwd, argv),
        sessionId: ctx.sessionId ?? '',
        agentId: ctx.agentId ?? '',
        command: ctx.command,
        argv: [...ctx.argv],
        cwd: ctx.cwd,
        paths: ctx.paths.map((p) => p.virtual),
        reason: rule.reason,
        rule,
        outcome: null,
        scope: Scope.ONCE,
        note: '',
      }
      this.add(ctx.sessionId ?? '', record)
      await this.flush()
    }
    if (this.onAsk === null) return { kind: 'pending', id: record.id, reason: rule.reason }
    const answered = await this.onAsk(record)
    if (answered === null || answered.outcome === null) {
      return { kind: 'pending', id: record.id, reason: rule.reason }
    }
    await this.answer(record.id, answered.outcome, answered.scope, answered.note)
    if (answered.outcome === Outcome.DENY) {
      return { kind: 'deny', reason: rule.reason, scope: 'command' }
    }
    return null
  }

  /** The question already recorded for this rule of this line. */
  private waiting(
    ctx: CommandContext,
    rule: CommandRule,
    argv: readonly string[],
  ): Decision | null {
    for (const record of this.records(ctx.sessionId ?? '')) {
      if (record.outcome === null && sameRule(record.rule, rule) && sameLine(record, argv, ctx.cwd))
        return record
    }
    return null
  }

  /**
   * The answered record standing behind one rule of a line, null when
   * nobody has answered it.
   */
  private static settled(
    held: readonly Decision[],
    rule: CommandRule,
    argv: readonly string[],
    cwd: string,
  ): Decision | null {
    for (const record of held) {
      if (record.scope === Scope.ONCE && covers(record, rule, argv, cwd)) return record
    }
    for (const record of held) {
      if (record.scope === Scope.SESSION && covers(record, rule, argv, cwd)) return record
    }
    return null
  }

  /** Drop the ONCE answers this line just used up. */
  private async spend(sessionId: string, spent: readonly Decision[]): Promise<void> {
    if (spent.length === 0) return
    const held = this.records(sessionId)
    this.set(
      sessionId,
      held.filter((r) => !spent.some((s) => s === r)),
    )
    await this.flush()
  }

  private keys(): string[] {
    if (this.sessions !== null) return [...this.sessions.decisionSessions()]
    return [...this.memory.keys()]
  }

  private records(sessionId: string): readonly Decision[] {
    if (this.sessions !== null) return this.sessions.decisionsOf(sessionId)
    return this.memory.get(sessionId) ?? []
  }

  private set(sessionId: string, records: Decision[]): void {
    if (this.sessions !== null) this.sessions.setDecisions(sessionId, records)
    else this.memory.set(sessionId, records)
  }

  private add(sessionId: string, record: Decision): void {
    this.set(sessionId, [...this.records(sessionId), record])
  }

  private async flush(): Promise<void> {
    if (this.sessions !== null) await this.sessions.flush()
  }
}
