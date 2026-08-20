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

import type { Policy } from '../base.ts'
import { lineAllowed } from '../match/allow.ts'
import { matchOp, matchRule, ruleScope } from '../match/rule.ts'
import type { Action, CommandContext, OpsContext, SessionCommandsQuery } from '../types.ts'

/**
 * The permissions document's `commands` blocks, enforced.
 *
 * Seeded by the workspace after `MountRootPolicy` (POSIX messages still
 * win) and before user policies, so a document rule speaks before a
 * coded one when both match. It reads the session's compiled tiers
 * through the narrow `SessionCommandsQuery` by the session id the door
 * put in the context, never through ambient state: an explicit fact
 * survives the async hop that drops a store. Verdicts render through
 * the one outcome table (`renderDeny`), so an agent cannot tell a
 * document deny from a coded one.
 *
 * `preCommand`: the allow arm (a line no allow list of a tier covers is
 * refused whole, though its head was visible), then the deny arm (the
 * first matching rule in tier order: whole-command or operand-scoped by
 * whether the rule names paths), then the ask arm (the first matching
 * ask rule in tier order raises an Ask, which the approval door answers
 * from the session's grants or the host). `preOps`: the pure path rules
 * of every tier, so FUSE, programmatic ops and the warm cache cannot
 * bypass a path a document protects; there is no ask at the op door.
 */
export class PermissionsPolicy implements Policy {
  private readonly sessions: SessionCommandsQuery

  constructor(sessions: SessionCommandsQuery) {
    this.sessions = sessions
  }

  preCommand(ctx: CommandContext): Action | null {
    const layers = this.sessions.commandsOf(ctx.sessionId ?? '')
    if (layers.length === 0) return null
    if (!lineAllowed(ctx, layers)) {
      const program = (
        ctx.program !== undefined && ctx.program.length > 0 ? ctx.program : [ctx.command]
      ).join(' ')
      return { kind: 'deny', reason: `${program} is not allowed` }
    }
    for (const spec of layers) {
      for (const rule of spec.deny) {
        const hit = matchRule(rule, ruleScope(rule), ctx)
        if (hit === null) continue
        if (hit.operand === null) return { kind: 'deny', reason: rule.reason }
        return { kind: 'deny', reason: `${hit.operand}: ${rule.reason}`, scope: 'operand' }
      }
    }
    for (const spec of layers) {
      for (const rule of spec.ask) {
        if (matchRule(rule, ruleScope(rule), ctx) !== null) {
          return { kind: 'ask', reason: rule.reason, rule }
        }
      }
    }
    return null
  }

  preOps(ctx: OpsContext): Action | null {
    for (const spec of this.sessions.commandsOf(ctx.sessionId ?? '')) {
      for (const rule of spec.deny) {
        if (matchOp(rule, ruleScope(rule), ctx)) return { kind: 'deny', reason: rule.reason }
      }
    }
    return null
  }
}
