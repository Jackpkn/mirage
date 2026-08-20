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

import type { CommandContext, CommandRule, AdmissionRules } from '../types.ts'
import { isGlob } from '../../utils/hidden.ts'
import { lineAllowed } from './allow.ts'
import { matchRule, ruleScope } from './rule.ts'

/**
 * What the role's rules say about one line. RUN is silence: no rule
 * spoke. NOT_ALLOWED is the allow list refusing a line whose head it
 * installed. DENY and ASK name the rule that spoke.
 */
export enum Outcome {
  RUN = 'run',
  NOT_ALLOWED = 'not_allowed',
  DENY = 'deny',
  ASK = 'ask',
}

/** The role's answer about one line, and what produced it. */
export interface Decision {
  /** Which verb spoke. */
  readonly outcome: Outcome
  /** The rule that spoke; null on RUN and on NOT_ALLOWED, which is the allow list rather than a rule. */
  readonly rule: CommandRule | null
  /**
   * The operand a path-scoped rule matched, as typed, which the GNU
   * voice prints (`rm: letters.txt: <reason>`); null when the rule
   * reaches the whole line.
   */
  readonly matchedPath: string | null
  /**
   * Where in the document the rule was written, for a host reading a
   * verdict: `top` or `mounts./repo`. Empty on RUN.
   */
  readonly source: string
}

/**
 * How specific a path entry is: the number of literal components before
 * its first wildcard.
 *
 * The one measure the path axis orders by. `/repo/sealed/*` is 2,
 * `/repo/*` and the plain subtree `/repo` are 1, and a slashless name
 * pattern like `*.key` is 0, since it anchors nothing. Every pattern the
 * document allows has an answer, so two rules about one path are always
 * comparable and nothing is ever guessed.
 */
export function anchorDepth(entry: string): number {
  let depth = 0
  for (const part of entry.replace(/^\/+|\/+$/g, '').split('/')) {
    if (part === '' || isGlob(part)) break
    depth += 1
  }
  return depth
}

/**
 * A rule's place on the path axis: the depth of its deepest path entry,
 * or 0 when it names none.
 *
 * A rule naming no path is not on this axis at all, **wherever it is
 * written**, so one in a mount section scores 0 exactly as a top-level
 * one does and the two are separated by verb alone. Writing it under
 * `mounts./repo` scopes it to lines working inside that mount
 * (`matchRule` reads `rule.mount`); it does not make it more specific
 * than a rule about the whole session. That is what keeps "denied
 * generally, asked inside one mount" inexpressible for a pathless rule,
 * which in practice means an account CLI: such a CLI reaches a service
 * and touches no mount, so scoping it to one was never meaningful.
 */
export function ruleDepth(rule: CommandRule): number {
  const paths = rule.paths ?? []
  return paths.length === 0 ? 0 : Math.max(...paths.map(anchorDepth))
}

// Which verb wins when two rules match at the same anchor depth. Deny
// before ask, and the allow list is not a rule so it never ties.
const VERB_ORDER: Readonly<Record<string, number>> = { [Outcome.DENY]: 0, [Outcome.ASK]: 1 }

/**
 * Whether a match beats the best one so far: deeper anchor first, then
 * the stronger verb, then the earlier rule (which is why this is
 * strict).
 */
function better(
  current: readonly [number, number] | null,
  depth: number,
  outcome: Outcome,
): boolean {
  if (current === null) return true
  const [bestDepth, bestVerb] = current
  if (depth !== bestDepth) return depth > bestDepth
  return (VERB_ORDER[outcome] ?? 0) < bestVerb
}

/**
 * Where in the document a rule was written, as a host reads it: the
 * mount section it belongs to, or the top level.
 */
export function sourceOf(rule: CommandRule): string {
  return (rule.mount ?? '') !== '' ? `mounts.${rule.mount ?? ''}` : 'top'
}

/**
 * The role's answer about one line: the whole law, in one place.
 *
 * Two rules, because a command name and a path are not the same kind of
 * thing. A rule naming no path is read by verb, deny before ask,
 * wherever it was written. A rule carrying paths is read by anchor
 * depth, the deeper entry winning, ties broken by verb. The allow list
 * is asked first, since a line no list covers never reaches a rule.
 *
 * `PermissionsPolicy` renders this into the outcome table and `explain`
 * reports it, so the two cannot disagree about what a line would do.
 */
export function decide(ctx: CommandContext, rules: AdmissionRules | null): Decision {
  if (rules === null) return { outcome: Outcome.RUN, rule: null, matchedPath: null, source: '' }
  if (!lineAllowed(ctx, rules)) {
    return {
      outcome: Outcome.NOT_ALLOWED,
      rule: null,
      matchedPath: null,
      source: 'commands.allow',
    }
  }
  let best: [number, number] | null = null
  let chosen: Decision = { outcome: Outcome.RUN, rule: null, matchedPath: null, source: '' }
  for (const [outcome, written] of [
    [Outcome.DENY, rules.deny],
    [Outcome.ASK, rules.ask],
  ] as const) {
    for (const rule of written) {
      const hit = matchRule(rule, ruleScope(rule), ctx)
      if (hit === null) continue
      const depth = ruleDepth(rule)
      if (!better(best, depth, outcome)) continue
      best = [depth, VERB_ORDER[outcome] ?? 0]
      chosen = {
        outcome,
        rule,
        matchedPath: hit.operand ?? null,
        source: sourceOf(rule),
      }
    }
  }
  return chosen
}
