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

import { compareCodePoints } from '../utils/sort.ts'

/**
 * Array-element callbacks the arithmetic evaluator resolves through.
 *
 * The evaluator owns no session, so a caller that wants `a[i]` and
 * `m[key]` to mean anything injects these two facts. The split is what
 * keeps subscript semantics out of the evaluator: whether the subscript
 * text is an arithmetic expression (indexed) or a literal key
 * (associative) is the variable's to answer, and only the session knows
 * the variable. `resolve` receives the evaluator's current view, pending
 * assignments included, so `i=2, a[i]` reads the new `i`; `read` answers
 * the element's stored text, null when unset.
 */
export interface ElementOps {
  resolve(name: string, subscript: string, env: Readonly<Record<string, string>>): string
  read(name: string, key: string): string | null
}

/**
 * One assignment an arithmetic evaluation produced. `key` is the
 * canonical subscript `ElementOps.resolve` gave, or null for a bare
 * name (which lands as element 0 of an array, or the scalar itself).
 */
export interface ArithWrite {
  readonly name: string
  readonly key: string | null
  readonly value: string
}

/**
 * What one arithmetic evaluation produced: the value plus the
 * assignments made, one per target, in the order of each target's last
 * write, for the caller to land through the session door. Bare and
 * subscripted targets share the one sequence, because a bare name
 * aliases element 0 and `((a[0]=1, a=2))` has to leave 2.
 */
export interface ArithResult {
  readonly value: bigint
  readonly writes: readonly ArithWrite[]
}

export const NodeType = Object.freeze({
  COMMAND: 'command',
  PIPELINE: 'pipeline',
  LIST: 'list',
  REDIRECTED_STATEMENT: 'redirected_statement',
  SUBSHELL: 'subshell',
  IF_STATEMENT: 'if_statement',
  FOR_STATEMENT: 'for_statement',
  WHILE_STATEMENT: 'while_statement',
  CASE_STATEMENT: 'case_statement',
  CASE_ITEM: 'case_item',
  FUNCTION_DEFINITION: 'function_definition',
  DECLARATION_COMMAND: 'declaration_command',
  UNSET_COMMAND: 'unset_command',
  TEST_COMMAND: 'test_command',
  COMPOUND_STATEMENT: 'compound_statement',
  NEGATED_COMMAND: 'negated_command',
  VARIABLE_ASSIGNMENT: 'variable_assignment',
  VARIABLE_ASSIGNMENTS: 'variable_assignments',
  FOR: 'for',
  SELECT: 'select',
  WHILE: 'while',
  UNTIL: 'until',
  EXPORT: 'export',
  LOCAL: 'local',
  WORD: 'word',
  NUMBER: 'number',
  COMMAND_NAME: 'command_name',
  VARIABLE_NAME: 'variable_name',
  SIMPLE_EXPANSION: 'simple_expansion',
  EXPANSION: 'expansion',
  COMMAND_SUBSTITUTION: 'command_substitution',
  ARITHMETIC_EXPANSION: 'arithmetic_expansion',
  CONCATENATION: 'concatenation',
  BRACE_EXPRESSION: 'brace_expression',
  STRING: 'string',
  STRING_CONTENT: 'string_content',
  RAW_STRING: 'raw_string',
  ANSI_C_STRING: 'ansi_c_string',
  TRANSLATED_STRING: 'translated_string',
  PROCESS_SUBSTITUTION: 'process_substitution',
  EXTGLOB_PATTERN: 'extglob_pattern',
  REGEX: 'regex',
  DO_GROUP: 'do_group',
  ELIF_CLAUSE: 'elif_clause',
  ELSE_CLAUSE: 'else_clause',
  FILE_REDIRECT: 'file_redirect',
  HEREDOC_REDIRECT: 'heredoc_redirect',
  HEREDOC_BODY: 'heredoc_body',
  HEREDOC_START: 'heredoc_start',
  HEREDOC_END: 'heredoc_end',
  HEREDOC_CONTENT: 'heredoc_content',
  HERESTRING_REDIRECT: 'herestring_redirect',
  FILE_DESCRIPTOR: 'file_descriptor',
  ARRAY: 'array',
  AND: '&&',
  OR: '||',
  SEMI: ';',
  BACKGROUND: '&',
  PIPE: '|',
  PIPE_STDERR: '|&',
  REDIRECT_OUT: '>',
  REDIRECT_CLOBBER: '>|',
  REDIRECT_APPEND: '>>',
  REDIRECT_IN: '<',
  REDIRECT_STDERR: '>&',
  REDIRECT_BOTH: '&>',
  REDIRECT_BOTH_APPEND: '&>>',
  HEREDOC_START_TOKEN: '<<',
  HERESTRING_TOKEN: '<<<',
  OPEN_PAREN: '(',
  CLOSE_PAREN: ')',
  OPEN_BRACE: '{',
  CLOSE_BRACE: '}',
  OPEN_BRACKET: '[',
  CLOSE_BRACKET: ']',
  DOUBLE_OPEN_PAREN: '((',
  DOUBLE_CLOSE_PAREN: '))',
  DOUBLE_SEMICOLON: ';;',
  DQUOTE: '"',
  IF: 'if',
  THEN: 'then',
  ELIF: 'elif',
  ELSE: 'else',
  FI: 'fi',
  IN: 'in',
  DO: 'do',
  DONE: 'done',
  CASE: 'case',
  ESAC: 'esac',
  FUNCTION: 'function',
  PROGRAM: 'program',
  BINARY_EXPRESSION: 'binary_expression',
  UNARY_EXPRESSION: 'unary_expression',
  NEGATION_EXPRESSION: 'negation_expression',
  PARENTHESIZED_EXPRESSION: 'parenthesized_expression',
  TERNARY_EXPRESSION: 'ternary_expression',
  POSTFIX_EXPRESSION: 'postfix_expression',
  ARITH_OPEN: '((',
  ARITH_CLOSE: '))',
  C_STYLE_FOR_STATEMENT: 'c_style_for_statement',
  TEST_OPERATOR: 'test_operator',
  SPECIAL_VARIABLE_NAME: 'special_variable_name',
  COMMENT: 'comment',
  ERROR: 'ERROR',
} as const)

export type NodeType = (typeof NodeType)[keyof typeof NodeType]

// Node types whose failure never triggers `set -e` by shape alone.
// Lists are NOT exempt: bash exits when the command after the final
// `&&`/`||` fails; short-circuit failures set Session.errexitImmune
// instead, so the executor loops skip only those.
export const ERREXIT_EXEMPT_TYPES: ReadonlySet<string> = new Set<string>([NodeType.NEGATED_COMMAND])

// Every letter bash's `set` accepts, mapped to the `-o` name it is a
// synonym for. The full table is here rather than only the letters
// mirage acts on, because a letter left out is silently dropped: `set -C`
// read as "no such option, ignore" is exactly the silent-accept the
// fail-loud rule exists to stop, and it made noclobber unreachable by its
// own letter while `set -o noclobber` worked.
export const SET_FLAG_TO_OPTION: Readonly<Record<string, string>> = Object.freeze({
  a: 'allexport',
  b: 'notify',
  e: 'errexit',
  f: 'noglob',
  h: 'hashall',
  k: 'keyword',
  m: 'monitor',
  n: 'noexec',
  p: 'privileged',
  t: 'onecmd',
  u: 'nounset',
  v: 'verbose',
  x: 'xtrace',
  B: 'braceexpand',
  C: 'noclobber',
  E: 'errtrace',
  H: 'histexpand',
  P: 'physical',
  T: 'functrace',
})

// Every name GNU's `set -o` accepts, pinned from `set -o` on
// debian:stable-slim. mirage acts on a few and stores the rest, mirroring
// how a cluster letter naming no option is kept rather than refused. A
// name absent from here is the one thing bash rejects outright, and it
// rejects it with exit 2 — which is what keeps a silently-ignored
// `set -o physical` from looking supported.
export const SET_OPTION_NAMES: ReadonlySet<string> = new Set([
  'allexport',
  'braceexpand',
  'emacs',
  'errexit',
  'errtrace',
  'functrace',
  'hashall',
  'histexpand',
  'history',
  'ignoreeof',
  'interactive-comments',
  'keyword',
  'monitor',
  'noclobber',
  'noexec',
  'noglob',
  'nolog',
  'notify',
  'nounset',
  'onecmd',
  'physical',
  'pipefail',
  'posix',
  'privileged',
  'verbose',
  'vi',
  'xtrace',
])

const DEFAULT_ON: ReadonlySet<string> = new Set(['braceexpand', 'hashall', 'interactive-comments'])

// What each option reads as before anything sets it, pinned from
// `bash -c 'set -o'` on debian:stable-slim (5.2.37). Only three are on,
// and all three are on for a non-interactive shell too, so this is the
// table `set -o` prints rather than an interactive shell's.
export const SET_OPTION_DEFAULTS: ReadonlyMap<string, boolean> = new Map(
  [...SET_OPTION_NAMES].sort(compareCodePoints).map((name) => [name, DEFAULT_ON.has(name)]),
)

// Every name GNU's `shopt` accepts and what it reads as before anything
// sets it, pinned from `bash -c shopt` on debian:stable-slim (5.2.37),
// in bash's own listing order. Kept apart from SET_OPTION_NAMES because
// bash keeps two vocabularies, `set -o` and `shopt`, with `shopt -o` as
// the one bridge.
export const SHOPT_DEFAULTS: ReadonlyMap<string, boolean> = new Map([
  ['autocd', false],
  ['assoc_expand_once', false],
  ['cdable_vars', false],
  ['cdspell', false],
  ['checkhash', false],
  ['checkjobs', false],
  ['checkwinsize', true],
  ['cmdhist', true],
  ['compat31', false],
  ['compat32', false],
  ['compat40', false],
  ['compat41', false],
  ['compat42', false],
  ['compat43', false],
  ['compat44', false],
  ['complete_fullquote', true],
  ['direxpand', false],
  ['dirspell', false],
  ['dotglob', false],
  ['execfail', false],
  ['expand_aliases', false],
  ['extdebug', false],
  ['extglob', false],
  ['extquote', true],
  ['failglob', false],
  ['force_fignore', true],
  ['globasciiranges', true],
  ['globskipdots', true],
  ['globstar', false],
  ['gnu_errfmt', false],
  ['histappend', false],
  ['histreedit', false],
  ['histverify', false],
  ['hostcomplete', true],
  ['huponexit', false],
  ['inherit_errexit', false],
  ['interactive_comments', true],
  ['lastpipe', false],
  ['lithist', false],
  ['localvar_inherit', false],
  ['localvar_unset', false],
  ['login_shell', false],
  ['mailwarn', false],
  ['no_empty_cmd_completion', false],
  ['nocaseglob', false],
  ['nocasematch', false],
  ['noexpand_translation', false],
  ['nullglob', false],
  ['patsub_replacement', true],
  ['progcomp', true],
  ['progcomp_alias', false],
  ['promptvars', true],
  ['restricted_shell', false],
  ['shift_verbose', false],
  ['sourcepath', true],
  ['varredir_close', false],
  ['xpg_echo', false],
])

// `shopt` names mirage refuses to turn on rather than store: `extglob`
// changes what the parser accepts, and mirage's grammar has no such
// mode, so a stored `on` would promise a syntax that still fails to
// parse. Refusing is the honest answer until the parser learns it.
export const SHOPT_UNSUPPORTED: ReadonlySet<string> = new Set(['extglob'])

export interface OptionWord {
  // Shell options the word turns on or off, in the order written.
  settings: [string, boolean][]
  // Cluster letters that name no shell option. `set` ignores them;
  // shell startup reads its own startup letters out of them and refuses
  // the rest.
  other: string
  // Words the option took, 2 for the `-o NAME` form.
  consumed: number
}

export const RedirectKind = Object.freeze({
  STDOUT: 'stdout',
  STDERR: 'stderr',
  STDIN: 'stdin',
  STDERR_TO_STDOUT: 'stderr_to_stdout',
  HEREDOC: 'heredoc',
  HERESTRING: 'herestring',
} as const)

export type RedirectKind = (typeof RedirectKind)[keyof typeof RedirectKind]

export interface RedirectInit {
  // The descriptor the redirect claims, -1 for `&>`.
  fd: number
  // The target path, or the dup'd fd number.
  target: unknown
  // The tree-sitter node the target came from.
  targetNode?: unknown
  // Which stream the redirect moves.
  kind?: RedirectKind
  // Whether the write appends rather than truncates.
  append?: boolean
  // Whether the operator was `>|`, which overrides `set -C` for this one
  // redirect and nothing else.
  clobber?: boolean
  // The process substitution feeding the target.
  pipeline?: unknown
  // Whether the target undergoes expansion.
  expandVars?: boolean
}

export class Redirect {
  readonly fd: number
  readonly target: unknown
  readonly targetNode: unknown
  readonly kind: RedirectKind
  readonly append: boolean
  readonly clobber: boolean
  pipeline: unknown
  readonly expandVars: boolean

  constructor(init: RedirectInit) {
    this.fd = init.fd
    this.target = init.target
    this.targetNode = init.targetNode ?? null
    this.kind = init.kind ?? RedirectKind.STDOUT
    this.append = init.append ?? false
    this.clobber = init.clobber ?? false
    this.pipeline = init.pipeline ?? null
    this.expandVars = init.expandVars ?? true
  }
}

export const ShellBuiltin = Object.freeze({
  PWD: 'pwd',
  CD: 'cd',
  EXPORT: 'export',
  UNSET: 'unset',
  LOCAL: 'local',
  SET: 'set',
  PRINTENV: 'printenv',
  ENV: 'env',
  WHOAMI: 'whoami',
  MAN: 'man',
  HISTORY: 'history',
  TRUE: 'true',
  FALSE: 'false',
  COLON: ':',
  SOURCE: 'source',
  DOT: '.',
  EVAL: 'eval',
  READ: 'read',
  MAPFILE: 'mapfile',
  READARRAY: 'readarray',
  SHIFT: 'shift',
  GETOPTS: 'getopts',
  TRAP: 'trap',
  SHOPT: 'shopt',
  UMASK: 'umask',
  ALIAS: 'alias',
  UNALIAS: 'unalias',
  LET: 'let',
  EXEC: 'exec',
  TEST: 'test',
  BRACKET: '[',
  DOUBLE_BRACKET: '[[',
  WAIT: 'wait',
  FG: 'fg',
  KILL: 'kill',
  JOBS: 'jobs',
  DISOWN: 'disown',
  PS: 'ps',
  ECHO: 'echo',
  PRINTF: 'printf',
  SLEEP: 'sleep',
  BASH: 'bash',
  SH: 'sh',
  PYTHON: 'python',
  PYTHON3: 'python3',
  NODE: 'node',
  JS: 'js',
  XARGS: 'xargs',
  TIMEOUT: 'timeout',
  COMMAND: 'command',
  TYPE: 'type',
  WHICH: 'which',
  BREAK: 'break',
  CONTINUE: 'continue',
  RETURN: 'return',
  EXIT: 'exit',
} as const)

export type ShellBuiltin = (typeof ShellBuiltin)[keyof typeof ShellBuiltin]

/**
 * The structural shape of a tree-sitter syntax node, so consumers can
 * walk a parsed line without depending on a concrete tree-sitter
 * binding (web-tree-sitter here, tree_sitter in Python). Mirrors the
 * Python side reading nodes through shell.types.
 */
export interface TSNodeLike {
  type: string
  text: string
  children: TSNodeLike[]
  namedChildren: TSNodeLike[]
  parent?: TSNodeLike | null
  isNamed?: boolean
  isMissing?: boolean
  startIndex?: number
  endIndex?: number
  startPosition?: { row: number; column: number }
  endPosition?: { row: number; column: number }
}
