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

import type { HiddenPaths } from '../../types.ts'
import { pathHidden } from '../../utils/hidden.ts'
import type { CommandContext, CommandRule, OpsContext } from '../types.ts'
import { lineTokens } from './allow.ts'
import { patternMatches } from './pattern.ts'

/**
 * A rule that applies to a line, and how far it reaches. `matchRule`
 * returns null when the rule does not apply, `{operand: null}` when the
 * rule refuses (or asks about) the whole line, and the operand as typed
 * when the rule is path-scoped and one operand fell under its paths, so
 * the refusal is scoped to that operand (`rm: x: <reason>`, exit 1)
 * rather than to the command (`rm: policy denied: <reason>`, 126).
 */
export interface RuleMatch {
  operand: string | null
}

function under(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(root + '/')
}

// Whether a line works inside a mount: its cwd is under the root or one
// of its paths is.
function touches(mount: string, ctx: CommandContext): boolean {
  if (under(ctx.cwd, mount)) return true
  return ctx.paths.some((p) => under(p.virtual, mount))
}

/**
 * Whether a rule applies to a line, and to which operand. Three
 * questions in order: the rule's command patterns (a prefix of the
 * line's tokens; none means every command), the rule's mount (a
 * mount-tier rule applies only to a line working inside it), the rule's
 * paths (none means the whole line; otherwise the first operand under
 * them scopes the match). `scope` is the rule's paths classified once
 * through `classifyPaths`, null when the rule names none.
 */
export function matchRule(
  rule: CommandRule,
  scope: HiddenPaths | null,
  ctx: CommandContext,
): RuleMatch | null {
  const commands = rule.commands ?? []
  if (commands.length > 0) {
    const tokens = lineTokens(ctx)
    if (!commands.some((p) => patternMatches(p, tokens))) return null
  }
  if (rule.mount !== undefined && rule.mount !== '' && !touches(rule.mount, ctx)) return null
  if (scope === null) return { operand: null }
  for (const p of ctx.paths) {
    if (pathHidden(scope, p.virtual)) return { operand: p.rawPath || p.virtual }
  }
  return null
}

/**
 * Whether a rule refuses an op: only a pure path rule can, since an op
 * does not know which command issued it.
 */
export function matchOp(rule: CommandRule, scope: HiddenPaths | null, ctx: OpsContext): boolean {
  if ((rule.commands ?? []).length > 0 || scope === null) return false
  return pathHidden(scope, ctx.path.virtual)
}
