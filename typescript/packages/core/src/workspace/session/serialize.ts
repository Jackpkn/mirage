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

import type { ApprovalDecision, CommandRule, CommandsSpec, Grant } from '../../policy/types.ts'

/** A compiled command tier as the session record stores it (the Python spelling). */
export interface CommandsJSON {
  allow: string[] | null
  ask: RuleJSON[]
  deny: RuleJSON[]
}

export interface RuleJSON {
  reason: string
  commands?: string[]
  paths?: string[]
  mount?: string
}

export function ruleToJSON(rule: CommandRule): RuleJSON {
  const out: RuleJSON = {
    reason: rule.reason,
    commands: [...(rule.commands ?? [])],
    paths: [...(rule.paths ?? [])],
  }
  if (rule.mount !== undefined && rule.mount !== '') out.mount = rule.mount
  return out
}

export function ruleFromJSON(data: RuleJSON): CommandRule {
  return {
    reason: data.reason,
    commands: data.commands ?? [],
    paths: data.paths ?? [],
    mount: data.mount ?? '',
  }
}

export function commandsToJSON(spec: CommandsSpec): CommandsJSON {
  return {
    allow: spec.allow === null ? null : [...spec.allow],
    ask: spec.ask.map(ruleToJSON),
    deny: spec.deny.map(ruleToJSON),
  }
}

export function commandsFromJSON(data: CommandsJSON): CommandsSpec {
  return {
    allow: data.allow ?? null,
    ask: data.ask.map(ruleFromJSON),
    deny: data.deny.map(ruleFromJSON),
  }
}

/** A host grant as the session record stores it (the Python spelling). */
export interface GrantJSON {
  decision: ApprovalDecision
  rule: RuleJSON
  argv: string[]
  cwd: string
}

export function grantToJSON(grant: Grant): GrantJSON {
  return {
    decision: grant.decision,
    rule: ruleToJSON(grant.rule),
    argv: [...grant.argv],
    cwd: grant.cwd,
  }
}

export function grantFromJSON(data: GrantJSON): Grant {
  return {
    decision: data.decision,
    rule: ruleFromJSON(data.rule),
    argv: data.argv,
    cwd: data.cwd,
  }
}
