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

import type { CommandContext, AdmissionRules } from '../types.ts'
import { patternMatches, patternNames } from './pattern.ts'

/**
 * Whether a session can see a command at all. A role without an allow
 * list hides nothing; a role with one hides every name none of its
 * patterns start with. Grammar builtins and shell functions are the
 * caller's exemptions, not this one's.
 */
export function headVisible(name: string, rules: AdmissionRules | null): boolean {
  if (rules?.allow == null) return true
  return rules.allow.some((p) => patternNames(p, name))
}

/**
 * The tokens a pattern reads: the door's normalization when it set one,
 * else the name and the raw argv (a context built by hand).
 */
export function lineTokens(ctx: CommandContext): readonly string[] {
  return ctx.tokens !== undefined && ctx.tokens.length > 0 ? ctx.tokens : [ctx.command, ...ctx.argv]
}

/**
 * Whether the role's allow list has a pattern for the whole line. A
 * word that is not a tool (`ctx.tool` cleared by the door: shell grammar,
 * the agent's own function, an executed path) is always allowed here; a
 * deny rule is the only thing that can refuse it.
 */
export function lineAllowed(ctx: CommandContext, rules: AdmissionRules | null): boolean {
  if (ctx.tool === false) return true
  if (rules?.allow == null) return true
  const tokens = lineTokens(ctx)
  return rules.allow.some((p) => patternMatches(p, tokens))
}
