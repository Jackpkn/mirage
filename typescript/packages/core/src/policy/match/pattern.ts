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

import { WILDCARD } from '../constants.ts'

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
