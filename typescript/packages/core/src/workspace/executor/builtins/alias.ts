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

import { IOResult } from '../../../io/types.ts'
import { SHOPT_DEFAULTS } from '../../../shell/types.ts'
import type { Session } from '../../session/session.ts'
import { ownRecord, sessionEntry, setSessionEntry } from '../../session/session.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './shared.ts'

const ALIAS_USAGE = 'alias: usage: alias [-p] [name[=value] ... ]'
const UNALIAS_USAGE = 'unalias: usage: unalias [-a] name [name ...]'
const BAD_NAME = ' \t\n/=$`\'"|&;()<>'

/** Whether a name holds a character bash refuses in an alias name. */
function hasBadChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (BAD_NAME.includes(name.charAt(i))) return true
  }
  return false
}
const FIRST_WORD = /\S+/

export type AliasMark = [number, number]

/** Render a value the way `alias` prints it: single-quoted, an embedded
 * quote spelled `'\''`. */
export function quoteAliasValue(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function refuse(cmd: string, msg: string, code: number): Result {
  const err = new TextEncoder().encode(msg)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: code, stderr: err }),
  ]
}

function splitOptions(args: string[], letters: string): [Set<string>, string[], string | null] {
  const flags = new Set<string>()
  let i = 0
  while (i < args.length) {
    const word = args[i] ?? ''
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    for (const ch of word.slice(1)) {
      if (!letters.includes(ch)) return [flags, [], `-${ch}`]
      flags.add(ch)
    }
    i++
  }
  return [flags, args.slice(i), null]
}

/** Define or print aliases. */
export function handleAlias(args: string[], session: Session, mark: AliasMark): Result {
  const [flags, operands, bad] = splitOptions(args, 'p')
  if (bad !== null)
    return refuse('alias', `bash: alias: ${bad}: invalid option\n${ALIAS_USAGE}\n`, 2)
  const lines: string[] = []
  const errors: string[] = []
  if (operands.length === 0 || flags.has('p')) {
    for (const name of Object.keys(session.aliases).sort(compareCodePoints)) {
      lines.push(`alias ${name}=${quoteAliasValue(session.aliases[name] ?? '')}`)
    }
  }
  for (const word of operands) {
    const eq = word.indexOf('=')
    if (eq >= 0) {
      const name = word.slice(0, eq)
      if (name === '' || hasBadChar(name)) {
        errors.push(
          name === ''
            ? `bash: alias: ${word}: not found`
            : `bash: alias: \`${name}': invalid alias name`,
        )
        continue
      }
      setSessionEntry(session.aliases, name, word.slice(eq + 1))
      session.aliasMarks.set(name, mark)
      continue
    }
    if (hasBadChar(word)) {
      errors.push(`bash: alias: \`${word}': invalid alias name`)
      continue
    }
    const val = sessionEntry(session.aliases, word)
    if (val !== undefined) lines.push(`alias ${word}=${quoteAliasValue(val)}`)
    else errors.push(`bash: alias: ${word}: not found`)
  }
  const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
  const err = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : null
  const code = errors.length > 0 ? 1 : 0
  return [
    out,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({
      command: 'alias',
      exitCode: code,
      ...(err !== null ? { stderr: err } : {}),
    }),
  ]
}

/** Remove aliases: the named ones, or all under `-a`. */
export function handleUnalias(args: string[], session: Session): Result {
  const [flags, operands, bad] = splitOptions(args, 'a')
  if (bad !== null)
    return refuse('unalias', `bash: unalias: ${bad}: invalid option\n${UNALIAS_USAGE}\n`, 2)
  if (flags.has('a')) {
    session.aliases = ownRecord<string>()
    session.aliasMarks.clear()
    return [null, new IOResult(), new ExecutionNode({ command: 'unalias', exitCode: 0 })]
  }
  if (operands.length === 0) return refuse('unalias', `${UNALIAS_USAGE}\n`, 2)
  const errors: string[] = []
  for (const name of operands) {
    if (sessionEntry(session.aliases, name) !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.aliases[name]
      session.aliasMarks.delete(name)
    } else errors.push(`bash: unalias: ${name}: not found`)
  }
  const err = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : null
  const code = errors.length > 0 ? 1 : 0
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({
      command: 'unalias',
      exitCode: code,
      ...(err !== null ? { stderr: err } : {}),
    }),
  ]
}

function aliasesOn(session: Session): boolean {
  return session.shopts.expand_aliases ?? SHOPT_DEFAULTS.get('expand_aliases') ?? false
}

/** The alias text a command word expands to, or null. */
export function aliasValue(session: Session, name: string, mark: AliasMark): string | null {
  if (!aliasesOn(session)) return null
  const value = sessionEntry(session.aliases, name)
  if (value === undefined || session.aliasStack.includes(name)) return null
  const seen = session.aliasMarks.get(name)
  if (seen?.[0] === mark[0] && seen[1] === mark[1]) return null
  return value
}

/**
 * The command line an aliased head word rewrites to, or null. The value
 * replaces the word; a value ending in a blank asks for the next word
 * to be checked too (bash's `alias sudo='sudo '` rule); the result is a
 * fresh line the parser reads again.
 */
export function aliasCommandText(
  session: Session,
  name: string,
  rest: string,
  mark: AliasMark,
): string | null {
  const value = aliasValue(session, name, mark)
  if (value === null) return null
  const seen = new Set([name])
  let out = value
  let tailSource = rest
  while (out.endsWith(' ') || out.endsWith('\t')) {
    const stripped = tailSource.replace(/^\s+/, '')
    const match = FIRST_WORD.exec(stripped)
    if (match === null || seen.has(match[0])) break
    const nxt = aliasValue(session, match[0], mark)
    if (nxt === null) break
    seen.add(match[0])
    out += nxt
    tailSource = stripped.slice(match[0].length)
  }
  const tail = tailSource.trim()
  return tail !== '' ? `${out} ${tail}` : out
}
