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

import { RecordApprover, requestId, type Approver } from './approver.ts'
import { EXACT_LINE_DECISIONS } from './constants.ts'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Ask,
  CommandContext,
  CommandRule,
  Deny,
  Grant,
  GrantScope,
  Pending,
  SessionGrantsQuery,
} from './types.ts'

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i])
}

function sameRule(a: CommandRule, b: CommandRule): boolean {
  return (
    a.reason === b.reason &&
    sameWords(a.commands ?? [], b.commands ?? []) &&
    sameWords(a.paths ?? [], b.paths ?? []) &&
    (a.mount ?? '') === (b.mount ?? '')
  )
}

/**
 * The rule an Ask is keyed on: the document's, or for a coded Ask one
 * synthesized over the program that asked, so a session grant reads
 * "stop asking me about this program".
 */
export function askRule(ctx: CommandContext, ask: Ask): CommandRule {
  if (ask.rule !== undefined) return ask.rule
  const program = (
    ctx.program !== undefined && ctx.program.length > 0 ? ctx.program : [ctx.command]
  ).join(' ')
  return { reason: ask.reason, commands: [program] }
}

/**
 * The workspace's approval door: turns an Ask into run, refuse or
 * pending, and is the host's handle on what is pending.
 *
 * Reached by the executor through the mount registry like the policy
 * chain, and by the host as `ws.approvals`. Grants are consulted only
 * after the policy chain returned an Ask, which is after every Deny had
 * its say, so a grant never re-opens a deny. They are read and written
 * through the session manager by id, so a line running in a fork
 * (`execute({cwd})`, a background job) consumes and earns the same
 * grants as the session it forked from. Without a manager (a bare
 * policy chain outside a workspace) grants live in memory. Mirrors the
 * Python Approvals.
 */
export class Approvals {
  private readonly approverImpl: Approver
  private readonly memory = new Map<string, readonly Grant[]>()

  constructor(
    private readonly sessions: SessionGrantsQuery | null = null,
    approver: Approver | null = null,
  ) {
    this.approverImpl = approver ?? new RecordApprover()
  }

  get approver(): Approver {
    return this.approverImpl
  }

  /**
   * The requests waiting for the host, oldest first. Only the recording
   * approver leaves any: a blocking one answers inside the line.
   */
  list(): readonly ApprovalRequest[] {
    return this.approverImpl instanceof RecordApprover ? this.approverImpl.pending() : []
  }

  /**
   * Answer a pending request yes: the retry of the exact line passes
   * once, or every line the rule covers passes for the rest of the
   * session. Throws when no pending request has that id.
   */
  async grant(approvalId: string, scope: GrantScope = 'once'): Promise<void> {
    const request = this.take(approvalId)
    const decision: ApprovalDecision = scope === 'once' ? 'allow_once' : 'allow_session'
    this.add(request.sessionId, {
      decision,
      rule: request.rule,
      argv: words(request),
      cwd: request.cwd,
    })
    await this.flush()
  }

  /**
   * Answer a pending request no: the retry of the exact line is refused
   * in the deny voice, once; asking again raises a new request. Throws
   * when no pending request has that id.
   */
  async deny(approvalId: string): Promise<void> {
    const request = this.take(approvalId)
    this.add(request.sessionId, {
      decision: 'deny',
      rule: request.rule,
      argv: words(request),
      cwd: request.cwd,
    })
    await this.flush()
  }

  /**
   * The executor's branch for an Ask: a held grant answers it, else the
   * approver is asked now. Resolves to null to run the line, a Deny to
   * refuse it, a Pending when the host has not decided.
   */
  async resolve(ctx: CommandContext, ask: Ask): Promise<Deny | Pending | null> {
    const rule = askRule(ctx, ask)
    const argv = [ctx.command, ...ctx.argv]
    const sessionId = ctx.sessionId ?? ''
    const held = this.grants(sessionId)
    for (const grant of held) {
      if (
        EXACT_LINE_DECISIONS.has(grant.decision) &&
        sameWords(grant.argv, argv) &&
        grant.cwd === ctx.cwd
      ) {
        this.set(
          sessionId,
          held.filter((g) => g !== grant),
        )
        return grant.decision === 'deny' ? { kind: 'deny', reason: ask.reason } : null
      }
    }
    for (const grant of held) {
      if (grant.decision === 'allow_session' && sameRule(grant.rule, rule)) return null
    }
    const request: ApprovalRequest = {
      id: await requestId(sessionId, ctx.cwd, argv),
      sessionId,
      agentId: ctx.agentId ?? '',
      command: ctx.command,
      argv: [...ctx.argv],
      cwd: ctx.cwd,
      paths: ctx.paths.map((p) => p.virtual),
      reason: ask.reason,
      rule,
    }
    const decision = await this.approverImpl.approve(request)
    if (decision === null) return { kind: 'pending', id: request.id, reason: ask.reason }
    if (decision === 'allow_session') {
      this.add(sessionId, { decision: 'allow_session', rule, argv, cwd: ctx.cwd })
      return null
    }
    if (decision === 'deny') return { kind: 'deny', reason: ask.reason }
    return null
  }

  private take(approvalId: string): ApprovalRequest {
    if (!(this.approverImpl instanceof RecordApprover)) {
      throw new Error(`no pending approval ${approvalId}`)
    }
    return this.approverImpl.take(approvalId)
  }

  private grants(sessionId: string): readonly Grant[] {
    if (this.sessions !== null) return this.sessions.grantsOf(sessionId)
    return this.memory.get(sessionId) ?? []
  }

  private set(sessionId: string, grants: readonly Grant[]): void {
    if (this.sessions !== null) this.sessions.setGrants(sessionId, grants)
    else this.memory.set(sessionId, grants)
  }

  private add(sessionId: string, grant: Grant): void {
    this.set(sessionId, [...this.grants(sessionId), grant])
  }

  private async flush(): Promise<void> {
    if (this.sessions !== null) await this.sessions.flush()
  }
}

function words(request: ApprovalRequest): readonly string[] {
  return [request.command, ...request.argv]
}
