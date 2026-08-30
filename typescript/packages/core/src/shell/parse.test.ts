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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { getParts, getRedirects, getText } from './helpers.ts'
import {
  commandInvocations,
  commandWords,
  envReads,
  createShellParser,
  findSyntaxError,
  findUnterminatedBacktick,
  opaqueReads,
  referencedNames,
  stripLineContinuation,
  type ShellParser,
} from './parse.ts'
import type { TSNodeLike } from './types.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

describe('createShellParser', () => {
  it('parses a simple command to a program root with a command child', () => {
    const root = parser.parse('echo hello')
    expect(root.type).toBe('program')
    expect(root.childCount).toBeGreaterThan(0)
    const command = root.child(0)
    expect(command?.type).toBe('command')
  })

  it('parses a pipeline to a program with a pipeline child', () => {
    const root = parser.parse('echo hello | grep world')
    expect(root.type).toBe('program')
    const pipeline = root.child(0)
    expect(pipeline?.type).toBe('pipeline')
  })

  it('parses a redirection', () => {
    const root = parser.parse('echo hi > /tmp/x.txt')
    expect(root.type).toBe('program')
    const stmt = root.child(0)
    expect(stmt?.type).toBe('redirected_statement')
  })

  it('exposes node text matching the source', () => {
    const root = parser.parse('cat /data/foo.txt')
    const command = root.child(0)
    expect(command?.text).toBe('cat /data/foo.txt')
  })

  it('returns the same parser interface across multiple parse() calls', () => {
    const a = parser.parse('ls')
    const b = parser.parse('pwd')
    expect(a.type).toBe('program')
    expect(b.type).toBe('program')
    expect(a.child(0)?.text).toBe('ls')
    expect(b.child(0)?.text).toBe('pwd')
  })
})

describe('createShellParser — realistic multi-statement command', () => {
  // Mirrors a command run by a user against an R2 mount that surfaced an
  // OPFS getFileHandle error. We don't dispatch here — we just verify the
  // parser tokenizes the command into exactly the structure we expect, so a
  // future regression in shell parsing can't quietly reroute grep elsewhere.
  const SRC =
    "find /r2/Review -maxdepth 3 -type f | sed 's#^#FILE #'; echo '---'; grep -RIl \"Base3\\|base3\" /r2/Review || true"

  it('produces a program with three top-level statements', () => {
    const root = parser.parse(SRC)
    expect(root.type).toBe('program')
    expect(root.namedChildren).toHaveLength(3)
  })

  it('first statement is a pipeline of find | sed', () => {
    const root = parser.parse(SRC)
    const first = root.namedChildren[0]
    expect(first?.type).toBe('pipeline')
    const cmds = first?.namedChildren.filter((n) => n.type === 'command') ?? []
    expect(cmds).toHaveLength(2)
    expect(cmds[0]?.text.startsWith('find /r2/Review')).toBe(true)
    expect(cmds[1]?.text.startsWith('sed ')).toBe(true)
  })

  it('second statement is echo with a single-quoted arg', () => {
    const root = parser.parse(SRC)
    const second = root.namedChildren[1]
    expect(second?.type).toBe('command')
    expect(second?.text).toBe("echo '---'")
  })

  it('third statement is grep || true', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    expect(third?.type).toBe('list')
    const left = third?.namedChildren[0]
    expect(left?.type).toBe('command')
    expect(left?.text.startsWith('grep ')).toBe(true)
    expect(third?.text.includes('|| true')).toBe(true)
  })

  it('quoted regex "Base3\\|base3" stays a single argument', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    const grepCmd = third?.namedChildren[0]
    expect(grepCmd?.type).toBe('command')
    // collect argv-style children: (name) + word-like args
    const args = grepCmd?.namedChildren ?? []
    const argTexts = args.map((n) => n.text)
    // Expect the regex appears as one element (with its surrounding quotes).
    const regexArg = argTexts.find((t) => t.includes('Base3'))
    expect(regexArg).toBe('"Base3\\|base3"')
  })

  it('grep target path /r2/Review parses as a single argument, no glob expansion at parse time', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    const grepCmd = third?.namedChildren[0]
    const args = grepCmd?.namedChildren ?? []
    const argTexts = args.map((n) => n.text)
    const pathArg = argTexts.find((t) => t === '/r2/Review')
    expect(pathArg).toBe('/r2/Review')
  })
})

describe('findSyntaxError', () => {
  it.each(['if then fi', 'echo (', 'for x do done', 'for', 'if', 'if; fi', 'echo "unterm'])(
    'flags structural syntax error in %j',
    (cmd) => {
      const root = parser.parse(cmd)
      expect(findSyntaxError(root)).not.toBeNull()
    },
  )

  it.each([
    'echo hi',
    'for x in a b; do echo $x; done',
    'if true; then echo y; fi',
    'cat /tmp/x | sort',
    "cat <<EN'D'\n$v\nEND",
    'echo bg &; echo fg',
    'for x in; do echo $x; done',
  ])('returns null for valid / recoverable %j', (cmd) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)).toBeNull()
  })
})

describe('(( reparse: subshell that immediately opens a subshell', () => {
  it('parses as nested subshells rather than an arithmetic command', () => {
    const root = parser.parse('((echo a); echo b)')
    expect(root.hasError).toBe(false)
    expect(root.namedChildren[0]?.type).toBe('subshell')
  })

  it('handles the backgrounded form', () => {
    expect(parser.parse('((echo s1; echo s2) & wait)').hasError).toBe(false)
  })

  it('leaves a genuine arithmetic command untouched', () => {
    expect(parser.parse('i=1; ((i++)); echo $i').hasError).toBe(false)
  })

  // Each opener is judged on its own span, not on the error region:
  // tree-sitter's ERROR swallows the valid `((i++))` next to the bad
  // opener, so scope alone would split both and silently turn the
  // arithmetic into a subshell running `i++`.
  it('handles a line mixing arithmetic and a nested subshell', () => {
    expect(parser.parse('i=1; ((i++)); ((echo x); echo $i)').hasError).toBe(false)
  })

  it('is not confused by a paren inside quotes', () => {
    expect(parser.parse('((echo ")"); echo b)').hasError).toBe(false)
  })

  it('handles two nested subshells on one line', () => {
    expect(parser.parse('((echo a); echo b); ((echo c); echo d)').hasError).toBe(false)
  })

  it('multibyte text before the opener does not shift offsets', () => {
    expect(parser.parse('echo é; ((echo a); echo b)').hasError).toBe(false)
  })

  it('still reports an unrelated syntax error', () => {
    expect(parser.parse('if then').hasError).toBe(true)
  })
})

// tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
// when the name is cut short by a name-terminating character: the `$`
// stays behind as a literal token and the rest splits into a sibling
// word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
// the orphaned expansion and reparses, so consumers see one whole word.
describe('$ reparse: later unbraced var cut off from its name', () => {
  it.each([
    ['echo hi > /api/$c/$id.json', '/api/$c/${id}.json'],
    ['echo hi > /api/$c/$id-x', '/api/$c/${id}-x'],
    ['echo hi > /w/$a/$b/$c', '/w/$a/${b}/$c'],
    ['echo hi > ${a}.$b.json', '${a}.${b}.json'],
    ['echo hi > /w/$c/$1.json', '/w/$c/${1}.json'],
  ])('keeps the redirect target of %j one word', (command, target) => {
    const statement = parser.parse(command).children[0] as TSNodeLike
    expect(statement.type).toBe('redirected_statement')
    const [, redirects] = getRedirects(statement)
    expect(redirects).toHaveLength(1)
    expect(redirects[0]?.target).toBe(target)
  })

  it('keeps a bare word one argument', () => {
    const command = parser.parse('echo /api/$c/$id.json').children[0] as TSNodeLike
    expect(getParts(command).map((p) => getText(p))).toEqual(['echo', '/api/$c/${id}.json'])
  })

  it('keeps an assignment one assignment', () => {
    // The broken parse split this into an assignment holding
    // `p=/api/$c/$` plus a command named `id.json`.
    const node = parser.parse('p=/api/$c/$id.json').namedChildren[0]
    expect(node?.type).toBe('variable_assignment')
    expect(getText(node as TSNodeLike)).toBe('p=/api/$c/${id}.json')
  })

  it.each([
    // A `$` bash keeps literal is left alone: no name character follows.
    ['echo a$ b', ['echo', 'a$', 'b']],
    ['echo $', ['echo', '$']],
  ])('leaves the literal dollar in %j untouched', (command, words) => {
    const node = parser.parse(command).children[0] as TSNodeLike
    expect(getParts(node).map((p) => getText(p))).toEqual(words)
  })
})

describe('stripLineContinuation', () => {
  it.each([
    // An odd-length trailing run ends in a live continuation.
    ['echo a\\', 'echo a'],
    ['echo a\\\\\\', 'echo a\\\\'],
    ['echo \\', 'echo '],
    // An even-length run is all escaped backslashes, so nothing goes.
    ['echo a\\\\', 'echo a\\\\'],
    ['echo a', 'echo a'],
    ['echo a\\ b', 'echo a\\ b'],
  ])('%j -> %j', (command, expected) => {
    expect(stripLineContinuation(command)).toBe(expected)
  })
})

describe('findUnterminatedBacktick', () => {
  it.each(['echo `echo a', 'echo "`echo \'`\'`"', 'echo a`', '`'])(
    'flags the open region in %j',
    (command) => {
      expect(findUnterminatedBacktick(command)).not.toBeNull()
    },
  )

  it.each([
    'echo `echo a`',
    'echo `echo a` `echo b`',
    // Single quotes protect a backtick, double quotes do not.
    "echo '`'",
    'echo "`echo a`"',
    'echo "\\`"',
    // Only a backslash escapes inside the region.
    'echo `echo \\`nested\\``',
    'echo a',
    'cat <<EOF\nplain\nEOF',
  ])('accepts balanced %j', (command) => {
    expect(findUnterminatedBacktick(command)).toBeNull()
  })
})

describe('referencedNames', () => {
  it.each<[string, string[]]>([
    ['echo $X', ['X']],
    ['echo ${X:-d}', ['X']],
    ['echo "$X"', ['X']],
    // Single quotes tokenize as raw_string with no children, so the
    // name inside is never a reference.
    ["echo '$X'", []],
    ['echo $((X+1))', ['X']],
    // The assignment's own name is a write, not a read; the
    // substitution body is walked.
    ['x=$(echo $Y)', ['Y']],
    ['cat <$F', ['F']],
    // The loop variable is a write; the word list is a read.
    ['for i in $L; do echo hi; done', ['L']],
    // Over-approximation on purpose: the walk is textual over the
    // whole tree, so a name an eval would read is fetched too.
    ['x=$(eval "$Z")', ['Z']],
    ['echo ${a[i]}', ['a']],
    ['(( X=Y+1 ))', ['X', 'Y']],
    ['export V=$W', ['W']],
    // Bare names under a declaring builtin declare or delete.
    ['readonly R', []],
    ['unset X', []],
    ['TOKEN=1 printenv', []],
    ['cat <<EOT\nhello $H\nEOT', ['H']],
    ['echo hi', []],
    // A definition's body runs at invocation, not here; the fill layer
    // joins invoked bodies back in through lineNodes.
    ['f() { echo "$T"; }', []],
    ['f() { echo "$T"; }; echo $U', ['U']],
  ])('%s reads %j', (command, names) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(referencedNames(root)).toEqual(new Set(names))
  })
})

describe('commandWords', () => {
  it.each<[string, string[]]>([
    ['echo hi', ['echo']],
    ['env | grep A', ['env', 'grep']],
    ['x=$(printenv)', ['printenv']],
    ['if env; then ls; fi', ['env', 'ls']],
    // The declaring builtins parse as their own node types; their
    // head word is still a command word.
    ['export X=1', ['export']],
    ['declare -p', ['declare']],
    ['unset X', ['unset']],
    ['set', ['set']],
    ['x=1', []],
    // A definition's body runs at invocation; only the call is a
    // command word here.
    ['f() { python3 x.py; }; f', ['f']],
  ])('%s speaks %j', (command, words) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(commandWords(root)).toEqual(new Set(words))
  })
})

describe('envReads', () => {
  it.each<[string, boolean, string[]]>([
    // env renders on any invocation: bare it prints, with a command it
    // hands the snapshot to a child.
    ['env', true, []],
    ['env FOO=1 mycmd', true, []],
    ['set', true, []],
    ['set -u', false, []],
    ['set -- a b', false, []],
    ['printenv', true, []],
    ['printenv -0', true, []],
    ['printenv PATH TOKEN', false, ['PATH', 'TOKEN']],
    // A print target only the runtime can spell selects everything.
    ['printenv $x', true, []],
    ['export', true, []],
    ['export -p', true, []],
    ['export -p TOKEN', false, ['TOKEN']],
    // Mutating forms read nothing: the write must not depend on a
    // source being alive.
    ['export TOKEN=local', false, []],
    ['export TOKEN', false, []],
    ['declare', true, []],
    ['declare -p A B', false, ['A', 'B']],
    ['declare -x OTHER=1', false, []],
    // readonly and local print sets a managed entry can never be in.
    ['readonly', false, []],
    ['echo hi', false, []],
    // Inside a substitution counts; inside a definition does not.
    ['x=$(env)', true, []],
    ['f() { env; }', false, []],
  ])('%s renders whole=%s names=%j', (command, whole, names) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    const reads = envReads(root)
    expect(reads.whole).toBe(whole)
    expect(reads.names).toEqual(new Set(names))
  })
})

describe('opaqueReads', () => {
  it.each<[string, boolean]>([
    ['echo ${!name}', true],
    ['echo ${!prefix@}', true],
    ['echo ${#name}', false],
    ['echo ${name:-d}', false],
    ['declare -n r=TOKEN', true],
    ['local -n r=TOKEN', true],
    ['typeset -n r=TOKEN', true],
    // -n means unexport / unset-the-ref there, not a nameref.
    ['export -n X', false],
    ['unset -n r', false],
    ['echo $T', false],
    // A definition's body is not read at definition time.
    ['f() { echo ${!name}; }', false],
  ])('%s opaque=%s', (command, opaque) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(opaqueReads(root)).toBe(opaque)
  })
})

describe('commandInvocations', () => {
  it.each<[string, [string | null, (string | null)[]][]]>([
    ['ntn api get PAGE', [['ntn', ['api', 'get', 'PAGE']]]],
    // A dynamic word arrives as null, distinguishable from absent.
    ['slack msg send --to $u', [['slack', ['msg', 'send', '--to', null]]]],
    // A dynamic head is null too: the program itself is undecidable
    // before expansion.
    ['$tool api get', [[null, ['api', 'get']]]],
    ['"$t"x run', [[null, ['run']]]],
    ['A=1 mycli run', [['mycli', ['run']]]],
    ['mycli \'lit arg\' "plain"', [['mycli', ['lit arg', 'plain']]]],
    ['mycli run > out.txt', [['mycli', ['run']]]],
    ['export X=1', []],
    ['f() { inner verb; }', []],
  ])('%s invokes %j', (command, invocations) => {
    const root = parser.parse(command) as unknown as TSNodeLike
    expect(commandInvocations(root)).toEqual(invocations)
  })
})
