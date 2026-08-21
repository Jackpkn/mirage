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

import { SPECS } from '../../commands/spec/index.ts'
import { PolicyError } from '../../policy/errors.ts'
import { headVisible } from '../../policy/match/allow.ts'
import { splitPattern } from '../../policy/match/pattern.ts'
import type { AdmissionRules, CommandRule } from '../../policy/types.ts'

/** The command name a pattern starts with, empty for a bare wildcard. */
function head(pattern: string): string {
  const token = splitPattern(pattern)[0] ?? ''
  return token === '*' ? '' : token
}

/**
 * Whether a deny pattern matches every line an ask pattern does.
 *
 * A pattern is a token prefix, so a shorter deny covers a longer ask
 * (`git` covers `git push`) and a `*` token in the deny covers whatever
 * the ask names there. The reverse never holds.
 */
function coversPattern(deny: string, ask: string): boolean {
  const want = splitPattern(deny)
  const have = splitPattern(ask)
  if (want.length > have.length) return false
  return want.every((w, i) => w === '*' || w === have[i])
}

/**
 * Whether a deny rule refuses every line an ask rule asks about.
 *
 * Three things have to hold, and each is the reason for one arm. The
 * deny must name no paths, or the ask still fires on the operands the
 * deny leaves alone. It must be written at the same anchor, which is
 * where deny beats ask unconditionally; across anchors the deeper rule
 * leads and which one that is depends on the line, so this reports
 * nothing rather than guess (a top-level deny does shadow a mount-scoped
 * ask on the same command, and is deliberately left to the run). And
 * every command the ask names must be covered by one of its patterns,
 * since an ask naming a command the deny misses still has work to do.
 */
function shadowed(ask: CommandRule, deny: CommandRule): boolean {
  if ((deny.paths ?? []).length > 0) return false
  if ((deny.mount ?? '') !== (ask.mount ?? '')) return false
  const denyCommands = deny.commands ?? []
  const askCommands = ask.commands ?? []
  if (denyCommands.length === 0) return true
  if (askCommands.length === 0) return false
  return askCommands.every((a) => denyCommands.some((d) => coversPattern(d, a)))
}

/**
 * The first rule naming a builtin the allow list never installs.
 *
 * A rule on a command the session cannot see reads as a guard and is not
 * one: the command was never installed, so nothing reaches the rule and
 * the operator is protected only in the document. Only a name this repo
 * ships a spec for is judged, because any other word may be a CLI the
 * host registers after the workspace is built, which `checkCliVerbs`
 * checks at `createSession` instead.
 */
function uninstalled(rules: AdmissionRules): string | null {
  if (rules.allow === null) return null
  for (const [verb, entries] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
  ] as const) {
    for (const rule of entries) {
      for (const pattern of rule.commands ?? []) {
        const name = head(pattern)
        if (name === '' || !(name in SPECS)) continue
        if (!headVisible(name, rules)) {
          return `${verb} rule names ${name}, which the allow list never installs, so the rule can never fire`
        }
      }
    }
  }
  return null
}

/**
 * The first ask an outranking deny already refuses.
 *
 * Deny is read before ask at the same anchor, so an ask a deny covers
 * can never be reached: the line is refused before anyone is asked, and
 * the sign-off the operator wrote is never requested.
 */
function deadAsk(rules: AdmissionRules): string | null {
  for (const ask of rules.ask) {
    for (const deny of rules.deny) {
      if (shadowed(ask, deny)) {
        const a = (ask.commands ?? []).join(', ') || '*'
        const d = (deny.commands ?? []).join(', ') || '*'
        return `ask rule ${a} can never fire: the deny rule ${d} refuses the same commands and outranks it`
      }
    }
  }
  return null
}

/**
 * Refuse a document whose rules cannot behave as written.
 *
 * Both checks name a rule that is dead on arrival, which is worse than a
 * missing rule because it reads as a guard. Raised where the document is
 * compiled, so a deployment learns at startup rather than the first time
 * an agent types the line the operator thought was covered.
 */
export function checkRules(rules: AdmissionRules | null): void {
  if (rules === null) return
  for (const problem of [uninstalled(rules), deadAsk(rules)]) {
    if (problem !== null) throw new PolicyError(problem)
  }
}

/**
 * Refuse a rule naming a verb the CLI it names does not have.
 *
 * Deferred to `createSession` rather than done beside the other two,
 * because a CLI is registered on the workspace after it is built: at
 * compile time `git push` is just two words, and only once `git` is
 * installed is there a program tree to check the verb against. A head
 * word no installed CLI claims is left alone, since it may be a command,
 * a function, or a CLI registered later.
 */
export function checkCliVerbs(
  rules: AdmissionRules | null,
  verbs: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  if (rules === null) return
  for (const [verb, entries] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
  ] as const) {
    for (const rule of entries) {
      for (const pattern of rule.commands ?? []) {
        const tokens = splitPattern(pattern)
        const cli = tokens[0]
        const name = tokens[1]
        if (tokens.length < 2 || cli === undefined || !verbs.has(cli)) continue
        if (name === '*' || (name !== undefined && verbs.get(cli)?.has(name) === true)) continue
        throw new PolicyError(
          `${verb} rule names ${pattern}, which the ${cli} CLI has no verb for, so the rule can never fire`,
        )
      }
    }
  }
}
