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

import { Language, type Node, Parser } from 'web-tree-sitter'

import type { TSNodeLike } from './types.ts'

export interface ShellParserConfig {
  engineWasm: Uint8Array | ArrayBuffer
  grammarWasm: Uint8Array | ArrayBuffer
}

export interface ShellParser {
  parse(command: string): Node
}

const ARITH_OPEN_TOKEN = '(('
const QUOTES = new Set(["'", '"'])

/**
 * Index just past the `)` closing the `(` at `start`.
 *
 * Parens inside quotes and backslash escapes do not count, so a command
 * substitution or a literal `")"` cannot throw off the depth. Returns
 * null when the parens never balance.
 */
function balancedEnd(text: string, start: number): number | null {
  let depth = 0
  let index = start
  let quote: string | null = null
  while (index < text.length) {
    const char = text[index] ?? ''
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (QUOTES.has(char)) {
      quote = char
    } else if (char === '\\') {
      index += 2
      continue
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return null
}

/**
 * Whether the construct at `start` is a real arithmetic command.
 *
 * Decided by parsing the balanced span on its own: `((i++))` stands
 * alone cleanly, while `((echo x); echo $i)` does not. Judging each
 * opener separately is what keeps a valid `((i++))` safe when it shares
 * a line with a broken one, since tree-sitter's error region covers
 * both. An unbalanced span is assumed arithmetic and left alone.
 */
function isArithmetic(parser: Parser, command: string, start: number): boolean {
  const end = balancedEnd(command, start)
  if (end === null) return true
  const span = parser.parse(command.slice(start, end))
  return !span?.rootNode.hasError
}

/**
 * Offsets of `((` tokens the parser could not make sense of.
 *
 * Only openers inside an ERROR subtree are reported.
 */
function failedArithOpeners(root: Node): number[] {
  const offsets: number[] = []
  const stack: [Node, boolean][] = [[root, false]]
  for (;;) {
    const entry = stack.pop()
    if (entry === undefined) break
    const [node, inError] = entry
    const errored = inError || node.type === 'ERROR'
    if (errored && node.type === ARITH_OPEN_TOKEN) offsets.push(node.startIndex)
    for (const child of node.children) {
      stack.push([child, errored])
    }
  }
  return offsets
}

// Drop a trailing backslash that continues the line, as bash does. The
// reader removes `\<newline>` before the parser ever sees it, and a
// backslash ending the input is the same thing with nothing left to
// continue onto: `echo a\` runs `echo a`. Only an odd-length run of
// trailing backslashes ends in a live one, since each earlier pair is an
// escaped backslash (`echo a\\` keeps its literal backslash).
export function stripLineContinuation(command: string): string {
  let trailing = 0
  for (let i = command.length - 1; i >= 0 && command[i] === '\\'; i -= 1) trailing += 1
  return trailing % 2 === 1 ? command.slice(0, -1) : command
}

// Locate a backtick substitution that is never closed. tree-sitter
// happily parses "echo `echo a" as a complete command, so the region has
// to be scanned directly. Quoting follows the shell reader: single quotes
// protect a backtick, double quotes do not, and once inside a
// substitution only a backslash escapes, which is why `"`echo '`'`"` is
// an error in bash rather than a quoted backtick.
export function findUnterminatedBacktick(command: string): string | null {
  let quote: string | null = null
  let dollarQuote = false
  let opened: number | null = null
  let lastDollar = -2
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (quote === "'") {
      // $'...' takes backslash escapes, so \' does not close it; a
      // plain '...' treats every backslash literally.
      if (dollarQuote && ch === '\\') {
        i += 2
        continue
      }
      if (ch === "'") {
        quote = null
        dollarQuote = false
      }
      i += 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (opened !== null) {
      if (ch === '`') opened = null
      i += 1
      continue
    }
    if (ch === '`') opened = i
    else if (ch === "'" && quote === null) {
      quote = "'"
      dollarQuote = lastDollar === i - 1
    } else if (ch === '"') quote = quote === '"' ? null : '"'
    else if (ch === '$') lastDollar = i
    i += 1
  }
  return opened !== null ? command.slice(opened) : null
}

const NAME_CONT = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/

/**
 * Offsets of literal `$` tokens cut off from their variable name.
 *
 * tree-sitter-bash 0.25.1 stops lexing a later unbraced expansion in a
 * word when a name-terminating character follows it, so
 * `> /api/$c/$id.json` parses as `/api/$c/$` plus a sibling word
 * `id.json`: the `$` lands in the tree as a literal token and the
 * expansion is gone. A literal `$` directly followed by a name
 * character is a shape no correct bash lex produces (bash would have
 * read an expansion), so each one marks a mis-parse. The `$` opening a
 * simple_expansion is that expansion's own token and is skipped.
 */
function orphanedDollarOffsets(root: Node, text: string): number[] {
  const offsets: number[] = []
  const stack: Node[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    for (const child of node.children) {
      if (
        !child.isNamed &&
        child.type === '$' &&
        node.type !== 'simple_expansion' &&
        NAME_CONT.test(text[child.endIndex] ?? '')
      ) {
        offsets.push(child.startIndex)
      }
      stack.push(child)
    }
  }
  return offsets
}

/**
 * Rewrite the expansion at `offset` into its braced spelling.
 *
 * `$id.json` becomes `${id}.json`, which says the same thing and is the
 * spelling the grammar reads correctly. Bash reads a single digit after
 * `$` as one positional parameter, so `$12` rebraces as `${1}2`.
 */
function rebraceDollar(text: string, offset: number): string {
  let end = offset + 1
  if (DIGIT.test(text[end] ?? '')) {
    end += 1
  } else {
    while (end < text.length && NAME_CONT.test(text[end] ?? '')) end += 1
  }
  return `${text.slice(0, offset)}\${${text.slice(offset + 1, end)}}${text.slice(end)}`
}

/**
 * Rebrace mis-lexed expansions and reparse until none remain.
 *
 * Every rebrace consumes one bare `$` and never writes a new one, so
 * the loop is bounded by the count of `$` characters. A retry that
 * parses worse than what it replaces is discarded.
 */
function repairOrphanedDollars(parser: Parser, root: Node, text: string): Node {
  const bound = text.split('$').length - 1
  for (let i = 0; i < bound; i += 1) {
    const offsets = orphanedDollarOffsets(root, text)
    if (offsets.length === 0) break
    for (const offset of offsets.sort((a, b) => b - a)) {
      text = rebraceDollar(text, offset)
    }
    const retried = parser.parse(text)
    if (retried === null || retried.rootNode.hasError) break
    root = retried.rootNode
  }
  return root
}

// `Parser.init` boots one wasm module for the whole process, so two callers
// that start at the same time used to race it: the second read the language
// out of a half-built module and threw "Incompatible language version 0".
// Every caller now awaits the same boot. A failed boot is not kept, or one bad
// start would poison every later parser.
let engineBoot: Promise<void> | null = null

export async function createShellParser(config: ShellParserConfig): Promise<ShellParser> {
  engineBoot ??= Parser.init({ wasmBinary: toArrayBuffer(config.engineWasm) }).catch(
    (err: unknown) => {
      engineBoot = null
      throw err
    },
  )
  await engineBoot
  const language = await Language.load(toUint8(config.grammarWasm))
  const parser = new Parser()
  parser.setLanguage(language)
  return {
    /**
     * Parse a shell command into a tree-sitter AST.
     *
     * A leading `((` is lexed as the arithmetic opener and the lexer
     * cannot back out, so a subshell that immediately opens another
     * subshell (`((echo a); echo b)`) fails to parse. Bash resolves the
     * same ambiguity by trying the arithmetic command and reparsing as
     * nested subshells when that fails; this does the same, splitting
     * only openers that already sit inside an error and keeping the
     * retry only if it parses cleanly. Commands that parse today are
     * untouched, so no working command's offsets move.
     *
     * A later unbraced `$var` followed by a name-terminating character
     * is mis-lexed by the grammar, leaving a literal `$` token behind
     * (see orphanedDollarOffsets); those expansions are rebraced and
     * the line reparsed, so the returned tree can spell `$id` as
     * `${id}`.
     */
    parse(command: string): Node {
      const source = stripLineContinuation(command)
      const tree = parser.parse(source)
      if (tree === null) {
        throw new Error('shell parse returned null')
      }
      let root = tree.rootNode
      let text = source
      if (root.hasError) {
        // Sitting inside an ERROR is not evidence that an opener is
        // broken: tree-sitter's error region swallows neighbouring tokens,
        // so a valid `((i++))` next to a bad opener reports as errored
        // too. Splitting it would silently turn arithmetic into a subshell
        // running `i++`, which is a wrong parse rather than a rejected
        // one. Each opener is judged on its own span instead.
        const offsets = [...new Set(failedArithOpeners(root))].filter(
          (o) => !isArithmetic(parser, source, o),
        )
        if (offsets.length > 0) {
          let split = source
          for (const offset of offsets.sort((a, b) => b - a)) {
            split = `${split.slice(0, offset + 1)} ${split.slice(offset + 1)}`
          }
          const retried = parser.parse(split)
          if (retried !== null && !retried.rootNode.hasError) {
            root = retried.rootNode
            text = split
          }
        }
      }
      if (text.includes('$')) {
        root = repairOrphanedDollars(parser, root, text)
      }
      return root
    },
  }
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

const BASH_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
])

const STRUCTURAL_TOKENS: ReadonlySet<string> = new Set([
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '"',
  "'",
  '`',
])

function isStructuralError(node: Node): boolean {
  for (const child of node.children) {
    if (child.isNamed) return true
    if (BASH_KEYWORDS.has(child.type)) return true
    if (STRUCTURAL_TOKENS.has(child.type)) return true
  }
  return false
}

function walkNamed(node: Node): Node[] {
  const out: Node[] = [node]
  for (const child of node.namedChildren) out.push(...walkNamed(child))
  return out
}

function isRecoveredQuotedHeredocEnd(previous: Node | null, error: Node): boolean {
  if (previous === null) return false
  const errorText = error.text.trim()
  if (errorText.length === 0) return false
  for (const candidate of walkNamed(previous)) {
    if (candidate.type !== 'heredoc_redirect') continue
    let start: string | null = null
    let end: string | null = null
    for (const child of candidate.namedChildren) {
      if (child.type === 'heredoc_start') start = child.text
      else if (child.type === 'heredoc_end') end = child.text
    }
    if (
      start !== null &&
      (start.includes("'") || start.includes('"')) &&
      (end === null || end.length === 0) &&
      start.replaceAll("'", '').replaceAll('"', '') === errorText
    ) {
      return true
    }
  }
  return false
}

/**
 * Locate a top-level structural syntax error in a parsed AST.
 *
 * Tree-sitter often recovers from minor anomalies (e.g. `for x in;`) by
 * producing a valid statement with an internal ERROR token. Bash accepts
 * those, so we only flag errors that surface as direct children of
 * `program` AND contain a bash keyword, a bracket / quote, or a recovered
 * named subtree. Stand-alone statement separators (`;`, `&`, `|`) inside an
 * ERROR are deliberately not flagged because bash itself accepts e.g. `& ;`.
 *
 * Returns the offending region's text, or `null` if the AST is clean.
 */
export function findSyntaxError(node: Node): string | null {
  if (!node.hasError) return null
  let previous: Node | null = null
  for (const child of node.children) {
    if (child.isMissing) return child.text
    if (child.type === 'ERROR' && isStructuralError(child)) {
      if (isRecoveredQuotedHeredocEnd(previous, child)) {
        previous = child
        continue
      }
      return child.text
    }
    if (child.isNamed) previous = child
  }
  return null
}

// Where a `variable_name` node is a write target rather than a read:
// the assignment's name and the for loop's variable. Everything else --
// expansions, arithmetic, subscripts -- reads the name.
const TARGET_NAME_FIELDS: Record<string, string> = {
  variable_assignment: 'name',
  for_statement: 'variable',
}

// Nodes whose bare `variable_name` children declare or delete a name
// (`readonly R`, `export Z`, `unset X`); their assignment children still
// carry reads and are walked.
const DECLARING_NODES: ReadonlySet<string> = new Set(['declaration_command', 'unset_command'])

/**
 * Whether two facade nodes name the same tree node. Web-tree-sitter
 * hands out a fresh wrapper per lookup, so `===` alone cannot tell a
 * node from a re-read of it; identity rides `id` when the facade has
 * one.
 */
function sameNode(a: TSNodeLike, b: TSNodeLike): boolean {
  return a === b || (a.id !== undefined && a.id === b.id)
}

function collectNames(node: TSNodeLike, out: Set<string>): void {
  if (node.type === 'function_definition') return
  if (node.type === 'variable_name') {
    if (node.text !== '') out.add(node.text)
    return
  }
  if (DECLARING_NODES.has(node.type)) {
    for (const child of node.children) {
      if (child.type !== 'variable_name') collectNames(child, out)
    }
    return
  }
  const field = TARGET_NAME_FIELDS[node.type]
  const target = field !== undefined ? (node.childForFieldName?.(field) ?? null) : null
  for (const child of node.children) {
    if (target !== null && sameNode(child, target)) continue
    collectNames(child, out)
  }
}

/**
 * Named nodes, skipping function_definition subtrees.
 *
 * A definition's body runs at invocation, not where it is defined, so
 * a read walk that descended into one would charge the defining line
 * for reads it never performs. The fill layer joins invoked bodies
 * back in through its own node set (`lineNodes`).
 */
function* walkNamedOutsideDefs(node: TSNodeLike): Generator<TSNodeLike> {
  if (node.type === 'function_definition') return
  yield node
  for (const child of node.namedChildren) {
    yield* walkNamedOutsideDefs(child)
  }
}

/**
 * Every variable name a parsed program may read when it runs.
 *
 * A textual over-approximation over the whole tree, which is safe by
 * construction: the worst a spurious name costs is one fetch. Walked
 * everywhere -- command substitution bodies, redirect targets, heredoc
 * bodies, arithmetic -- with two exceptions that are writes, not reads
 * (an assignment's own name, a for loop's variable), one that runs
 * later rather than now (a function definition's body, which the fill
 * layer joins back in at invocation), and one the grammar gives for
 * free: a single-quoted string tokenizes as `raw_string` with no
 * children, so `'$X'` never reads X.
 */
export function referencedNames(node: TSNodeLike): ReadonlySet<string> {
  const out = new Set<string>()
  collectNames(node, out)
  return out
}

/**
 * The first word of every command a parsed program runs.
 *
 * What the whole-env scan and the CLI env-name lookup key on.
 * `command_name` covers ordinary commands wherever they sit; the
 * declaring builtins (`export`, `declare`, `local`, `readonly`,
 * `unset`) parse as their own node types whose head word is the first
 * anonymous token, so those are read directly. A function definition's
 * body is skipped: those commands run at invocation, where the fill
 * layer walks the stored body instead.
 */
export function commandWords(node: TSNodeLike): ReadonlySet<string> {
  const out = new Set<string>()
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'command_name') {
      if (current.text !== '') out.add(current.text)
    } else if (DECLARING_NODES.has(current.type)) {
      const head = current.children[0]
      if (head !== undefined && head.text !== '') out.add(head.text)
    }
  }
  return out
}

// The declaring builtins whose bare invocation prints the environment
// (`export`, `export -p`, `declare`); `local` prints only a function's
// locals and `readonly` only the read-only set, neither of which a
// managed entry can be.
const DECL_PRINTER_HEADS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset'])

// The declaring builtins whose `-n` makes the operand a nameref.
// `export -n` and `unset -n` mean other things and are not these.
const NAMEREF_HEADS: ReadonlySet<string> = new Set(['declare', 'typeset', 'local'])

/**
 * The argument's text when the parser fixed it, else null.
 *
 * A plain word, a number, a raw string and a double-quoted string of
 * plain content each spell one literal; anything carrying an expansion
 * or a substitution is dynamic and reads as null.
 */
function literalText(node: TSNodeLike): string | null {
  if (node.type === 'word' || node.type === 'number') {
    return node.text !== '' ? node.text : null
  }
  if (node.type === 'raw_string') {
    return node.text.slice(1, -1)
  }
  if (node.type === 'string') {
    const named = node.namedChildren
    if (named.length === 0) return ''
    const only = named[0]
    if (named.length === 1 && only?.type === 'string_content') {
      return only.text
    }
  }
  return null
}

interface DeclarationParts {
  head: string
  flags: string[]
  operands: TSNodeLike[]
}

function declarationParts(node: TSNodeLike): DeclarationParts {
  const first = node.children[0]
  const head = first !== undefined ? first.text : ''
  const flags: string[] = []
  const operands: TSNodeLike[] = []
  for (const child of node.children.slice(1)) {
    if (child.type === 'word') {
      if (child.text.startsWith('-')) flags.push(child.text)
      else operands.push(child)
    } else if (child.isNamed === true || node.namedChildren.some((n) => sameNode(n, child))) {
      operands.push(child)
    }
  }
  return { head, flags, operands }
}

function flagHas(flags: string[], letter: string): boolean {
  return flags.some(
    (flag) => flag.startsWith('-') && !flag.startsWith('--') && flag.slice(1).includes(letter),
  )
}

function commandArgs(node: TSNodeLike): TSNodeLike[] {
  const nameNode = node.childForFieldName?.('name') ?? null
  return node.namedChildren.filter(
    (child) =>
      (nameNode === null || !sameNode(child, nameNode)) &&
      child.type !== 'variable_assignment' &&
      !child.type.endsWith('_redirect'),
  )
}

/**
 * Names an `env` invocation provably keeps from the environment it
 * hands on: null when it reads no existing name at all, else the set a
 * whole-environment read may skip.
 *
 * Scanned with the builtin's own option grammar: `--` ends the
 * options, `-u`/`--unset` consume a value (so `-u -i` unsets a
 * variable named `-i` rather than clearing) and add it to the
 * exclusions, the leading `NAME=VALUE` operands override and exclude
 * their names, and the first other operand ends the scan. `-i`,
 * `--ignore-environment` or the lone `-` empties the start entirely,
 * and an option the builtin refuses stops it from running at all; both
 * answer null. The scan is left to right like the builtin's, so
 * everything consumed before the first word no static read can spell
 * keeps its effect whatever that word turns out to be, and nothing
 * after it is claimed: a dynamic word may be the command, demoting
 * every later word to an argument.
 */
function envExclusions(args: TSNodeLike[]): ReadonlySet<string> | null {
  const excluded = new Set<string>()
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    const literal = arg === undefined ? null : literalText(arg)
    if (literal === null) return excluded
    if (literal === '--') {
      i += 1
      break
    }
    if (literal === '-i' || literal === '--ignore-environment' || literal === '-') return null
    if (literal === '--unset') {
      if (i + 1 >= args.length) return null
      const next = args[i + 1]
      const value = next === undefined ? null : literalText(next)
      if (value !== null) excluded.add(value)
      i += 2
      continue
    }
    if (literal.startsWith('--unset=')) {
      excluded.add(literal.slice('--unset='.length))
      i += 1
      continue
    }
    if (literal === '-0' || literal === '--null') {
      i += 1
      continue
    }
    if (literal.startsWith('--')) return null
    if (literal.startsWith('-') && literal.length > 1) {
      let step = 1
      let bad = false
      for (let pos = 1; pos < literal.length; pos += 1) {
        const ch = literal[pos]
        if (ch === 'i') return null
        if (ch === 'u') {
          const rest = literal.slice(pos + 1)
          if (rest !== '') {
            excluded.add(rest)
          } else if (i + 1 < args.length) {
            const next = args[i + 1]
            const value = next === undefined ? null : literalText(next)
            if (value !== null) excluded.add(value)
            step = 2
          } else {
            return null
          }
          break
        }
        if (ch !== '0') {
          bad = true
          break
        }
      }
      if (bad) return null
      i += step
      continue
    }
    break
  }
  while (i < args.length) {
    const arg = args[i]
    const literal = arg === undefined ? null : literalText(arg)
    if (literal === null) return excluded
    if (!literal.includes('=') || literal.startsWith('=')) break
    excluded.add(literal.split('=', 1)[0] ?? '')
    i += 1
  }
  return excluded
}

/**
 * Names a command's assignment prefixes provably override.
 *
 * `TOKEN=local printenv TOKEN` hands the command an environment whose
 * TOKEN is the override, so an environment read through that
 * invocation cannot observe the standing value whatever the override
 * expands to; the value's own reads are the walk's business. `+=`
 * appends to the standing value and proves nothing.
 */
function prefixAssignmentNames(node: TSNodeLike): Set<string> {
  const out = new Set<string>()
  for (const child of node.namedChildren) {
    if (child.type !== 'variable_assignment') continue
    if (child.children.some((part) => part.type === '+=')) continue
    const nameNode = child.childForFieldName?.('name') ?? null
    if (nameNode?.type !== 'variable_name') continue
    if (nameNode.text !== '') out.add(nameNode.text)
  }
  return out
}

/**
 * How the line's environment-rendering commands read names.
 *
 * Returns `{whole, names, excluded}`: whether some command renders the
 * whole environment, the names printing forms read explicitly, and the
 * names every whole-environment read provably skips. Only a printing
 * form selects everything: `env` on any invocation (bare it prints
 * every exported name, and with arguments it hands the snapshot to the
 * command it runs) unless a literal `-i`, `--ignore-environment` or
 * lone `-` proves it starts empty, a bare `set`, a bare `printenv`,
 * and a declaring builtin with no operands (`export`, `declare -p`).
 * `printenv NAME` and `declare -p NAME` read exactly the named
 * variables, and a mutating form (`export NAME=v`, `declare -x NAME`,
 * `set -u`) reads nothing here, so an unavailable source cannot fail
 * the write that would replace its pointer. A print target no static
 * read can spell (`printenv $x`) falls back to the whole environment.
 *
 * Exclusions are per invocation: an assignment prefix overrides its
 * name for exactly that command's environment, and `env`'s `-u`,
 * `--unset` and `NAME=VALUE` words remove or override theirs
 * (`envExclusions`), so `env -u TOKEN printenv TOKEN` cannot observe
 * TOKEN however the whole snapshot is handed on. A print target so
 * excluded is dropped rather than reported. `excluded` is the
 * intersection across the node's whole-environment reads, because a
 * name is skippable only when every such read skips it.
 */
export function envReads(node: TSNodeLike): {
  whole: boolean
  names: ReadonlySet<string>
  excluded: ReadonlySet<string>
} {
  let whole = false
  let excluded: ReadonlySet<string> | null = null
  const names = new Set<string>()
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'command') {
      const nameNode = current.childForFieldName?.('name') ?? null
      const head = nameNode !== null ? nameNode.text : ''
      const prefix = prefixAssignmentNames(current)
      let skipped: ReadonlySet<string> | null = null
      if (head === 'env') {
        const scanned = envExclusions(commandArgs(current))
        if (scanned !== null) skipped = new Set([...prefix, ...scanned])
      } else if (head === 'set') {
        if (commandArgs(current).length === 0) skipped = prefix
      } else if (head === 'printenv') {
        let readAny = false
        for (const child of commandArgs(current)) {
          const literal = literalText(child)
          if (literal === null) {
            skipped = prefix
            readAny = true
          } else if (!literal.startsWith('-')) {
            if (!prefix.has(literal)) names.add(literal)
            readAny = true
          }
        }
        if (!readAny) skipped = prefix
      }
      if (skipped !== null) {
        whole = true
        const skip = skipped
        const prior: ReadonlySet<string> | null = excluded
        // The parameter annotation breaks tsc's circular inference:
        // `excluded` is assigned from an arrow whose context is itself.
        excluded =
          prior === null ? skip : new Set([...prior].filter((name: string) => skip.has(name)))
      }
    } else if (current.type === 'declaration_command') {
      const { head, flags, operands } = declarationParts(current)
      if (!DECL_PRINTER_HEADS.has(head)) continue
      let selected = false
      if (operands.length === 0) {
        selected = true
      } else if (flagHas(flags, 'p')) {
        for (const operand of operands) {
          if (operand.type === 'variable_name') {
            if (operand.text !== '') names.add(operand.text)
          } else if (operand.type !== 'variable_assignment') {
            selected = true
          }
        }
      }
      if (selected) {
        whole = true
        excluded = new Set()
      }
    }
  }
  return { whole, names, excluded: excluded ?? new Set() }
}

/**
 * Whether the line reads names no static walk can spell.
 *
 * Two constructs defeat `referencedNames`: an indirect expansion
 * (`${!name}` reads the variable the *value* of `name` names, and the
 * `${!p*}`/`${!p@}` forms enumerate by prefix), and a nameref declared
 * on the line itself (`declare -n r=T; echo $r` reads T before any
 * session record says so). A nameref from an earlier line is not
 * opaque: the session records its target, which `deref` resolves.
 */
export function opaqueReads(node: TSNodeLike): boolean {
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'expansion' && current.children.some((c) => c.type === '!')) {
      return true
    }
    if (current.type === 'declaration_command') {
      const { head, flags } = declarationParts(current)
      if (NAMEREF_HEADS.has(head) && flagHas(flags, 'n')) return true
    }
  }
  return false
}

/**
 * Every plain command's head word with its argument words.
 *
 * Head and arguments are reported as their literal text, or null for a
 * word no static read can spell (an expansion, a substitution), so a
 * caller matching names (the CLI env-name pruning) can tell "this word
 * is not there" from "this word is unknowable". A null head is the
 * stronger fact: the command that runs is not decidable before
 * expansion, so the fill pass treats the line as an opaque read.
 * Assignment prefixes and redirects are not arguments.
 */
export function commandInvocations(node: TSNodeLike): [string | null, (string | null)[]][] {
  const out: [string | null, (string | null)[]][] = []
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type !== 'command') continue
    const nameNode = current.childForFieldName?.('name') ?? null
    if (nameNode === null) continue
    const only = nameNode.namedChildren.length === 1 ? nameNode.namedChildren[0] : undefined
    const head = only !== undefined ? literalText(only) : null
    out.push([head, commandArgs(current).map(literalText)])
  }
  return out
}
