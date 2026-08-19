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

import type { CommandRule, CommandsSpec } from '../types.ts'
import { patternNames, splitPattern } from './pattern.ts'

/**
 * Whether any tier states a command rule at all: an allow list, an ask
 * or a deny.
 */
export function hasRules(layers: readonly CommandsSpec[]): boolean {
  return layers.some(
    (layer) => layer.allow !== null || layer.ask.length > 0 || layer.deny.length > 0,
  )
}

/**
 * Whether a rule needs a line's words past the command name to decide
 * about a command: it names the command (or every command) and reads
 * paths, a mount, or a token after the name.
 */
function ruleReadsArgs(rule: CommandRule, name: string): boolean {
  const commands = rule.commands ?? []
  const names = commands.length === 0 || commands.some((p) => patternNames(p, name))
  if (!names) return false
  if ((rule.paths ?? []).length > 0 || (rule.mount ?? '') !== '') return true
  return commands.some((p) => patternNames(p, name) && splitPattern(p).length > 1)
}

/**
 * Whether a rule in force reads a command's words past its name.
 *
 * The whole-line gate asks this for a word the runtime, not the gate,
 * will expand: the head of every command is read by every rule, but an
 * argument only matters to a pattern with a token after the name
 * (`git push`), a path-scoped rule, or a mount-scoped one, so a dynamic
 * argument to a command no such rule names is nothing a rule would have
 * seen anyway.
 */
export function readsArgs(layers: readonly CommandsSpec[], name: string): boolean {
  for (const layer of layers) {
    for (const pattern of layer.allow ?? []) {
      if (patternNames(pattern, name) && splitPattern(pattern).length > 1) return true
    }
    for (const rule of [...layer.ask, ...layer.deny]) {
      if (ruleReadsArgs(rule, name)) return true
    }
  }
  return false
}
