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
import { classifyPaths, pathCovers, pathHidden } from '../../utils/hidden.ts'
import { METADATA_OPS, SUBTREE_COMMANDS, SUBTREE_OPS } from '../constants.ts'
import type { CommandContext, CommandRule, CommandsSpec, OpsContext } from '../types.ts'
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
  return subtreeMatch(scope, ctx)
}

/**
 * The operand of a subtree command that holds the scope, if any. `rm -r
 * /x` and `mv /x /y` take `/x/locked/*` along, so for the commands in
 * SUBTREE_COMMANDS an operand at or above the directory holding the
 * scope matches like an operand inside it. `mv`'s last operand is its
 * destination, which only matches when it is that directory itself
 * (moving into `/x/locked` lands in the scope; moving into `/x` does
 * not).
 */
function subtreeMatch(scope: HiddenPaths, ctx: CommandContext): RuleMatch | null {
  if (!SUBTREE_COMMANDS.has(ctx.command)) return null
  const operands = [...(ctx.operands ?? [])]
  const dst = ctx.command === 'mv' && operands.length > 1 ? operands.pop() : undefined
  for (const p of operands) {
    if (pathCovers(scope, p.virtual)) return { operand: p.rawPath || p.virtual }
  }
  if (dst !== undefined && pathCovers(scope, dst.virtual, false)) {
    return { operand: dst.rawPath || dst.virtual }
  }
  return null
}

/**
 * Whether a rule refuses an op: only a pure path rule can, since an op
 * does not know which command issued it. The op's path is tested against
 * the scope, and an op that moves or removes a whole subtree
 * (SUBTREE_OPS) is also refused on the directory holding the scope or on
 * any ancestor, since it would take the scope along. A metadata op
 * (METADATA_OPS) passes: deny is present and refused, so the entry stats
 * and its content is what the door withholds.
 */
export function matchOp(rule: CommandRule, scope: HiddenPaths | null, ctx: OpsContext): boolean {
  // A metadata op passes: deny is present and refused, so the entry
  // stats and its content is what the door withholds.
  if ((rule.commands ?? []).length > 0 || scope === null || METADATA_OPS.has(ctx.op)) return false
  if (pathHidden(scope, ctx.path.virtual)) return true
  // An op that moves or removes a whole subtree is also refused on the
  // directory holding the scope or on any ancestor: it would take the
  // scope along.
  return SUBTREE_OPS.has(ctx.op) && pathCovers(scope, ctx.path.virtual)
}

const scopes = new WeakMap<CommandRule, HiddenPaths | null>()

/**
 * A rule's paths, classified once and remembered: null when the rule
 * names none, so a caller can tell a whole-line rule from a path-scoped
 * one without re-reading the document grammar.
 */
export function ruleScope(rule: CommandRule): HiddenPaths | null {
  const known = scopes.get(rule)
  if (known !== undefined) return known
  const scope = classifyPaths(rule.paths ?? [])
  scopes.set(rule, scope)
  return scope
}

/**
 * Whether a rule reaches an entry a command touches on its own, below
 * its operands: the rule names the line (its command patterns against
 * the line's tokens, none meaning every command) and its paths hold the
 * entry. A rule with no paths spoke about the whole line at admission
 * and has nothing to add at an entry; the directory holding a scope is
 * not in it, so a listing still shows a refused entry's name, which is
 * what deny means: present, and refused.
 */
export function matchIo(
  rule: CommandRule,
  scope: HiddenPaths | null,
  tokens: readonly string[],
  virtual: string,
): boolean {
  if (scope === null) return false
  const commands = rule.commands ?? []
  if (commands.length > 0 && !commands.some((p) => patternMatches(p, tokens))) return false
  return pathHidden(scope, virtual)
}

/**
 * The reason a command may not touch an entry it reached on its own,
 * null when it may.
 *
 * The same precedence the admission gate applies to a line: the deny
 * rules in tier order, the first that reaches the entry refusing it;
 * then the ask rules in tier order, where the first that reaches it
 * refuses unless the line holds a grant under that rule (the nod the gate
 * took for `rm -r /x` covers the entries under `/x`; a walk that wanders
 * into an asked scope from outside gets no nod mid-command, so it is
 * refused and the agent names the path to be asked).
 */
export function ioRefusal(
  layers: readonly CommandsSpec[],
  tokens: readonly string[],
  virtual: string,
  granted: readonly CommandRule[],
): string | null {
  for (const spec of layers) {
    for (const rule of spec.deny) {
      if (matchIo(rule, ruleScope(rule), tokens, virtual)) return rule.reason
    }
  }
  for (const spec of layers) {
    for (const rule of spec.ask) {
      if (matchIo(rule, ruleScope(rule), tokens, virtual)) {
        return granted.includes(rule) ? null : rule.reason
      }
    }
  }
  return null
}
