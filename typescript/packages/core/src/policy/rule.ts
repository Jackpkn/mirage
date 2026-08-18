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

import type { Policy } from './base.ts'
import type { Action, CommandContext, CommandRule, OpsContext } from './types.ts'
import type { HiddenPaths } from '../types.ts'
import { classifyPaths, pathHidden } from '../utils/hidden.ts'

/**
 * A CommandRule compiled to a policy.
 *
 * Internal: the workspace builds one per rule of the document's
 * `commands.deny`; nothing outside the package constructs it. The
 * rule's paths compile through the same classifier as `paths.hide` and
 * match through the same matcher, so a deny scope and a hide read one
 * grammar.
 */
export class RulePolicy implements Policy {
  readonly rule: CommandRule
  private readonly scope: HiddenPaths | null

  constructor(rule: CommandRule) {
    this.rule = rule
    this.scope = classifyPaths(rule.paths ?? [])
  }

  preCommand(ctx: CommandContext): Action | null {
    const commands = this.rule.commands ?? []
    if (commands.length > 0 && !commands.includes(ctx.command)) return null
    if (this.scope === null) {
      return { kind: 'deny', message: `${ctx.command}: ${this.rule.reason}\n`, exitCode: 1 }
    }
    for (const p of ctx.paths) {
      if (pathHidden(this.scope, p.virtual)) {
        const display = p.rawPath || p.virtual
        return {
          kind: 'deny',
          message: `${ctx.command}: ${display}: ${this.rule.reason}\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  preOps(ctx: OpsContext): Action | null {
    // The op-layer twin: pure path protection (no command scope) also
    // holds at the op door, so FUSE, programmatic ops, and the warm
    // cache cannot bypass it. Command-scoped rules stay command-layer:
    // an op does not know which command issued it.
    const commands = this.rule.commands ?? []
    if (commands.length > 0 || this.scope === null) return null
    if (pathHidden(this.scope, ctx.path.virtual)) {
      return { kind: 'deny', message: `${this.rule.reason}\n`, exitCode: 1 }
    }
    return null
  }
}
