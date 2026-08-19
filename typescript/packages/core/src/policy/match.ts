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

import type { HiddenPaths } from '../types.ts'
import { pathHidden } from '../utils/hidden.ts'
import type { CommandContext, CommandRule, CommandsSpec, OpsContext } from './types.ts'

/**
 * The one pattern token that matches any one line token; trailing, it
 * matches whatever follows, which a prefix already does.
 */
export const WILDCARD = '*'

/**
 * A rule that applies to a line: `operand` is the operand as typed that
 * a path-scoped rule matched, null when the rule refuses the whole line.
 */
export interface RuleHit {
  operand: string | null
}

/**
 * A command pattern's tokens. Whitespace-split; trailing wildcards are
 * dropped because a pattern is a prefix and already matches any
 * continuation (`git *` and `git` are the same rule; a bare `*` is every
 * command).
 */
export function splitPattern(pattern: string): string[] {
  const tokens = pattern.split(/\s+/).filter((t) => t !== '')
  while (tokens.length > 0 && tokens[tokens.length - 1] === WILDCARD) tokens.pop()
  return tokens
}

/** Whether a pattern is a prefix of a line's tokens (command name first). */
export function patternMatches(pattern: string, tokens: readonly string[]): boolean {
  const want = splitPattern(pattern)
  if (want.length > tokens.length) return false
  return want.every((w, i) => w === WILDCARD || w === tokens[i])
}

/**
 * Whether a pattern can match some line of a command. Visibility asks
 * this: a name is installed for the session when a pattern of every
 * allow list starts with it (or with the wildcard), whatever the rest of
 * the pattern requires of the line.
 */
export function patternNames(pattern: string, name: string): boolean {
  const want = splitPattern(pattern)
  return want.length === 0 || want[0] === WILDCARD || want[0] === name
}

/**
 * Whether a session can see a command at all. A tier without an allow
 * list hides nothing; a tier with one hides every name none of its
 * patterns start with. Grammar-tier builtins and shell functions are
 * the caller's exemptions, not this one's.
 */
export function headVisible(name: string, layers: readonly CommandsSpec[]): boolean {
  for (const spec of layers) {
    if (spec.allow === null) continue
    if (!spec.allow.some((p) => patternNames(p, name))) return false
  }
  return true
}

/**
 * The tokens a pattern reads: the door's normalization when it set one,
 * else the name and the raw argv (a context built by hand).
 */
export function lineTokens(ctx: CommandContext): readonly string[] {
  return ctx.tokens !== undefined && ctx.tokens.length > 0 ? ctx.tokens : [ctx.command, ...ctx.argv]
}

/**
 * Whether every tier with an allow list has a pattern for the line. A
 * word that is not a tool (`ctx.tool` cleared by the door: shell grammar,
 * the agent's own function, an executed path) is always allowed here; a
 * deny rule is the only thing that can refuse it.
 */
export function lineAllowed(ctx: CommandContext, layers: readonly CommandsSpec[]): boolean {
  if (ctx.tool === false) return true
  const tokens = lineTokens(ctx)
  for (const spec of layers) {
    if (spec.allow === null) continue
    if (!spec.allow.some((p) => patternMatches(p, tokens))) return false
  }
  return true
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
 * Whether a rule applies to a line, and to which operand. `scope` is the
 * rule's paths classified once through `classifyPaths`, null when the
 * rule names none.
 */
export function ruleHit(
  rule: CommandRule,
  scope: HiddenPaths | null,
  ctx: CommandContext,
): RuleHit | null {
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
export function opHit(rule: CommandRule, scope: HiddenPaths | null, ctx: OpsContext): boolean {
  if ((rule.commands ?? []).length > 0 || scope === null) return false
  return pathHidden(scope, ctx.path.virtual)
}

function unify(a: readonly string[], b: readonly string[]): string[] | null {
  const out: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = i < a.length ? a[i] : undefined
    const y = i < b.length ? b[i] : undefined
    if (x === undefined) out.push(y ?? WILDCARD)
    else if (y === undefined) out.push(x)
    else if (x === y || y === WILDCARD) out.push(x)
    else if (x === WILDCARD) out.push(y)
    else return null
  }
  return out
}

/**
 * The allow list both lists grant: every pair unified token by token,
 * the longer prefix winning where one extends the other and a wildcard
 * yielding to the concrete token.
 */
export function intersectPatterns(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = []
  for (const x of a) {
    for (const y of b) {
      const joined = unify(splitPattern(x), splitPattern(y))
      if (joined === null) continue
      const text = joined.join(' ') || WILDCARD
      if (!out.includes(text)) out.push(text)
    }
  }
  return out
}
