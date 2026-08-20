# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, TypeAlias

import tree_sitter

FunctionBody: TypeAlias = list[tree_sitter.Node]


@dataclass(frozen=True, slots=True)
class ElementOps:
    """Array-element callbacks the arithmetic evaluator resolves through.

    The evaluator owns no session, so a caller that wants ``a[i]`` and
    ``m[key]`` to mean anything injects these two facts. The split is
    what keeps subscript semantics out of the evaluator: whether the
    subscript text is an arithmetic expression (indexed) or a literal
    key (associative) is the variable's to answer, and only the session
    knows the variable.

    Args:
        resolve (Callable[[str, str, Mapping[str, str]], str]): canonical
            key for one reference: the evaluated index for an indexed
            name, the literal (quote-stripped) text for an associative
            one. The mapping is the evaluator's current view, pending
            assignments included, so ``i=2, a[i]`` reads the new ``i``.
        read (Callable[[str, str], str | None]): the element's stored
            text, None when the element is unset.
    """
    resolve: Callable[[str, str, Mapping[str, str]], str]
    read: Callable[[str, str], str | None]


@dataclass(frozen=True, slots=True)
class ArithWrite:
    """One assignment an arithmetic evaluation produced.

    Args:
        name (str): the variable's name.
        key (str | None): the canonical subscript ``ElementOps.resolve``
            gave, or None for a bare name (which lands as element 0 of
            an array, or the scalar itself).
        value (str): the stored decimal text.
    """
    name: str
    key: str | None
    value: str


@dataclass(frozen=True, slots=True)
class ArithResult:
    """What one arithmetic evaluation produced.

    Args:
        value (int): the expression's value.
        writes (tuple[ArithWrite, ...]): the assignments made, one per
            target, in the order of each target's last write, for the
            caller to land through the session door. Bare and
            subscripted targets share the one sequence, because a bare
            name aliases element 0 and ``((a[0]=1, a=2))`` has to
            leave 2.
    """
    value: int
    writes: tuple[ArithWrite, ...] = ()


class NodeType(StrEnum):
    """Tree-sitter-bash node types."""
    COMMAND = "command"
    PIPELINE = "pipeline"
    LIST = "list"
    REDIRECTED_STATEMENT = "redirected_statement"
    SUBSHELL = "subshell"
    IF_STATEMENT = "if_statement"
    FOR_STATEMENT = "for_statement"
    WHILE_STATEMENT = "while_statement"
    CASE_STATEMENT = "case_statement"
    CASE_ITEM = "case_item"
    FUNCTION_DEFINITION = "function_definition"
    DECLARATION_COMMAND = "declaration_command"
    UNSET_COMMAND = "unset_command"
    TEST_COMMAND = "test_command"
    COMPOUND_STATEMENT = "compound_statement"
    NEGATED_COMMAND = "negated_command"
    VARIABLE_ASSIGNMENT = "variable_assignment"
    VARIABLE_ASSIGNMENTS = "variable_assignments"
    FOR = "for"
    SELECT = "select"
    WHILE = "while"
    UNTIL = "until"
    EXPORT = "export"
    LOCAL = "local"
    WORD = "word"
    NUMBER = "number"
    COMMAND_NAME = "command_name"
    VARIABLE_NAME = "variable_name"
    SIMPLE_EXPANSION = "simple_expansion"
    EXPANSION = "expansion"
    COMMAND_SUBSTITUTION = "command_substitution"
    ARITHMETIC_EXPANSION = "arithmetic_expansion"
    CONCATENATION = "concatenation"
    BRACE_EXPRESSION = "brace_expression"
    STRING = "string"
    STRING_CONTENT = "string_content"
    RAW_STRING = "raw_string"
    ANSI_C_STRING = "ansi_c_string"
    TRANSLATED_STRING = "translated_string"
    PROCESS_SUBSTITUTION = "process_substitution"
    EXTGLOB_PATTERN = "extglob_pattern"
    REGEX = "regex"
    DO_GROUP = "do_group"
    ELIF_CLAUSE = "elif_clause"
    ELSE_CLAUSE = "else_clause"
    FILE_REDIRECT = "file_redirect"
    HEREDOC_REDIRECT = "heredoc_redirect"
    HEREDOC_BODY = "heredoc_body"
    HEREDOC_START = "heredoc_start"
    HEREDOC_END = "heredoc_end"
    HEREDOC_CONTENT = "heredoc_content"
    HERESTRING_REDIRECT = "herestring_redirect"
    FILE_DESCRIPTOR = "file_descriptor"
    ARRAY = "array"
    AND = "&&"
    OR = "||"
    SEMI = ";"
    BACKGROUND = "&"
    PIPE = "|"
    PIPE_STDERR = "|&"
    REDIRECT_OUT = ">"
    REDIRECT_CLOBBER = ">|"
    REDIRECT_APPEND = ">>"
    REDIRECT_IN = "<"
    REDIRECT_STDERR = ">&"
    REDIRECT_BOTH = "&>"
    REDIRECT_BOTH_APPEND = "&>>"
    HEREDOC_START_TOKEN = "<<"
    HERESTRING_TOKEN = "<<<"
    OPEN_PAREN = "("
    CLOSE_PAREN = ")"
    OPEN_BRACE = "{"
    CLOSE_BRACE = "}"
    OPEN_BRACKET = "["
    CLOSE_BRACKET = "]"
    DOUBLE_OPEN_PAREN = "(("
    DOUBLE_CLOSE_PAREN = "))"
    DOUBLE_SEMICOLON = ";;"
    DQUOTE = '"'
    IF = "if"
    THEN = "then"
    ELIF = "elif"
    ELSE = "else"
    FI = "fi"
    IN = "in"
    DO = "do"
    DONE = "done"
    CASE = "case"
    ESAC = "esac"
    FUNCTION = "function"
    PROGRAM = "program"
    BINARY_EXPRESSION = "binary_expression"
    UNARY_EXPRESSION = "unary_expression"
    NEGATION_EXPRESSION = "negation_expression"
    PARENTHESIZED_EXPRESSION = "parenthesized_expression"
    TERNARY_EXPRESSION = "ternary_expression"
    POSTFIX_EXPRESSION = "postfix_expression"
    ARITH_OPEN = "(("
    ARITH_CLOSE = "))"
    C_STYLE_FOR_STATEMENT = "c_style_for_statement"
    TEST_OPERATOR = "test_operator"
    SPECIAL_VARIABLE_NAME = "special_variable_name"
    COMMENT = "comment"
    ERROR = "ERROR"


# Node types whose failure never triggers `set -e` by shape alone.
# Lists are NOT exempt: bash exits when the command after the final
# `&&`/`||` fails; short-circuit failures set Session.errexit_immune
# instead, so the executor loops skip only those.
ERREXIT_EXEMPT_TYPES = frozenset({
    NodeType.NEGATED_COMMAND,
})

# Every letter bash's `set` accepts, mapped to the `-o` name it is a
# synonym for. The full table is here rather than only the letters
# mirage acts on, because a letter left out is silently dropped: `set -C`
# read as "no such option, ignore" is exactly the silent-accept the
# fail-loud rule exists to stop, and it made noclobber unreachable by its
# own letter while `set -o noclobber` worked.
SET_FLAG_TO_OPTION = {
    "a": "allexport",
    "b": "notify",
    "e": "errexit",
    "f": "noglob",
    "h": "hashall",
    "k": "keyword",
    "m": "monitor",
    "n": "noexec",
    "p": "privileged",
    "t": "onecmd",
    "u": "nounset",
    "v": "verbose",
    "x": "xtrace",
    "B": "braceexpand",
    "C": "noclobber",
    "E": "errtrace",
    "H": "histexpand",
    "P": "physical",
    "T": "functrace",
}

# Every name GNU's `set -o` accepts, pinned from `set -o` on
# debian:stable-slim. mirage acts on a few and stores the rest, mirroring
# how a cluster letter naming no option is kept rather than refused. A
# name absent from here is the one thing bash rejects outright, and it
# rejects it with exit 2 -- which is what keeps a silently-ignored
# `set -o physical` from looking supported.
SET_OPTION_NAMES = frozenset({
    "allexport",
    "braceexpand",
    "emacs",
    "errexit",
    "errtrace",
    "functrace",
    "hashall",
    "histexpand",
    "history",
    "ignoreeof",
    "interactive-comments",
    "keyword",
    "monitor",
    "noclobber",
    "noexec",
    "noglob",
    "nolog",
    "notify",
    "nounset",
    "onecmd",
    "physical",
    "pipefail",
    "posix",
    "privileged",
    "verbose",
    "vi",
    "xtrace",
})

# Every name GNU's `shopt` accepts and what it reads as before anything
# sets it, pinned from `bash -c shopt` on debian:stable-slim (5.2.37), in
# the order bash lists them (which is alphabetical except that
# `assoc_expand_once` follows `autocd`). Kept apart from SET_OPTION_NAMES
# because bash keeps two vocabularies: `set -o` and `shopt`, with
# `shopt -o` as the one bridge. mirage acts on the glob ones and on
# `expand_aliases`, and stores the rest so a listing prints every option
# bash knows and `shopt -q` answers the same way it would there.
SHOPT_DEFAULTS: dict[str, bool] = {
    "autocd": False,
    "assoc_expand_once": False,
    "cdable_vars": False,
    "cdspell": False,
    "checkhash": False,
    "checkjobs": False,
    "checkwinsize": True,
    "cmdhist": True,
    "compat31": False,
    "compat32": False,
    "compat40": False,
    "compat41": False,
    "compat42": False,
    "compat43": False,
    "compat44": False,
    "complete_fullquote": True,
    "direxpand": False,
    "dirspell": False,
    "dotglob": False,
    "execfail": False,
    "expand_aliases": False,
    "extdebug": False,
    "extglob": False,
    "extquote": True,
    "failglob": False,
    "force_fignore": True,
    "globasciiranges": True,
    "globskipdots": True,
    "globstar": False,
    "gnu_errfmt": False,
    "histappend": False,
    "histreedit": False,
    "histverify": False,
    "hostcomplete": True,
    "huponexit": False,
    "inherit_errexit": False,
    "interactive_comments": True,
    "lastpipe": False,
    "lithist": False,
    "localvar_inherit": False,
    "localvar_unset": False,
    "login_shell": False,
    "mailwarn": False,
    "no_empty_cmd_completion": False,
    "nocaseglob": False,
    "nocasematch": False,
    "noexpand_translation": False,
    "nullglob": False,
    "patsub_replacement": True,
    "progcomp": True,
    "progcomp_alias": False,
    "promptvars": True,
    "restricted_shell": False,
    "shift_verbose": False,
    "sourcepath": True,
    "varredir_close": False,
    "xpg_echo": False,
}

# `shopt` names mirage refuses to turn on rather than store: `extglob`
# changes what the *parser* accepts (`!(a).txt` is a pattern, not a
# subshell), and mirage's grammar has no such mode, so a stored `on`
# would promise a syntax that still fails to parse. Refusing is the
# honest answer until the parser learns it.
SHOPT_UNSUPPORTED = frozenset({"extglob"})

# What each option reads as before anything sets it, pinned from
# `bash -c 'set -o'` on debian:stable-slim (5.2.37). Only three are on,
# and all three are on for a non-interactive shell too, so this is the
# table `set -o` prints rather than an interactive shell's.
SET_OPTION_DEFAULTS: dict[str, bool] = {
    name: name in ("braceexpand", "hashall", "interactive-comments")
    for name in sorted(SET_OPTION_NAMES)
}


@dataclass(frozen=True, slots=True)
class OptionWord:
    """One word of the shell's option grammar.

    Args:
        settings (tuple[tuple[str, bool], ...]): shell options the word
            turns on or off, in the order they were written.
        other (str): cluster letters that name no shell option. `set`
            ignores them; shell startup reads its own startup letters
            out of them and refuses the rest.
        consumed (int): words the option took, 2 for the `-o NAME` form.
    """
    settings: tuple[tuple[str, bool], ...] = ()
    other: str = ""
    consumed: int = 1


class RedirectKind(StrEnum):
    STDOUT = "stdout"
    STDERR = "stderr"
    STDIN = "stdin"
    STDERR_TO_STDOUT = "stderr_to_stdout"
    HEREDOC = "heredoc"
    HERESTRING = "herestring"


@dataclass
class Redirect:
    """Parsed redirect from a redirected_statement.

    Args:
        fd (int): the descriptor the redirect claims, -1 for `&>`.
        target (Any): the target path, or the dup'd fd number.
        target_node (Any): the tree-sitter node the target came from.
        kind (RedirectKind): which stream the redirect moves.
        append (bool): whether the write appends rather than truncates.
        clobber (bool): whether the operator was `>|`, which overrides
            `set -C` for this one redirect and nothing else.
        pipeline (Any): the process substitution feeding the target.
        expand_vars (bool): whether the target undergoes expansion.
    """
    fd: int
    target: Any
    target_node: Any = None
    kind: RedirectKind = RedirectKind.STDOUT
    append: bool = False
    clobber: bool = False
    pipeline: Any = None
    expand_vars: bool = True


class ShellBuiltin(StrEnum):
    """Shell builtin command names.

    Commands that don't touch the filesystem.
    Handled directly by the executor, not dispatched
    to mounts. Listed by tier and group (``BUILTIN_GROUP``
    below is the source of truth).
    """
    # grammar: the shell's own language
    # -- working directory
    PWD = "pwd"
    CD = "cd"
    # -- variables and positional parameters
    EXPORT = "export"
    UNSET = "unset"
    LOCAL = "local"
    # declare / typeset / readonly are parser-owned (the declaration
    # node runs them, they never reach the executor's table); rows here
    # so `type` reports them and the tiers file them as grammar.
    DECLARE = "declare"
    TYPESET = "typeset"
    READONLY = "readonly"
    SET = "set"
    READ = "read"
    MAPFILE = "mapfile"
    READARRAY = "readarray"
    SHIFT = "shift"
    GETOPTS = "getopts"
    LET = "let"
    # -- shell state
    TRAP = "trap"
    SHOPT = "shopt"
    UMASK = "umask"
    ALIAS = "alias"
    UNALIAS = "unalias"
    EXEC = "exec"
    # -- conditions
    TEST = "test"
    BRACKET = "["
    DOUBLE_BRACKET = "[["
    # -- output
    ECHO = "echo"
    PRINTF = "printf"
    # -- running lines
    SOURCE = "source"
    DOT = "."
    EVAL = "eval"
    COMMAND = "command"
    # -- name lookup
    TYPE = "type"
    WHICH = "which"
    # -- status and control flow
    TRUE = "true"
    FALSE = "false"
    COLON = ":"
    BREAK = "break"
    CONTINUE = "continue"
    RETURN = "return"
    EXIT = "exit"
    # tools: programs the line invokes
    # -- environment and identity
    PRINTENV = "printenv"
    ENV = "env"
    WHOAMI = "whoami"
    # -- manuals and history
    MAN = "man"
    HISTORY = "history"
    # -- job control
    WAIT = "wait"
    FG = "fg"
    KILL = "kill"
    JOBS = "jobs"
    DISOWN = "disown"
    PS = "ps"
    # -- clock
    SLEEP = "sleep"
    # -- nested shells
    BASH = "bash"
    SH = "sh"
    # -- interpreters
    PYTHON = "python"
    PYTHON3 = "python3"
    NODE = "node"
    JS = "js"
    # -- command runners
    XARGS = "xargs"
    TIMEOUT = "timeout"


class BuiltinTier(StrEnum):
    """Which of two things a shell builtin is to a permission rule.

    ``GRAMMAR`` is the shell's own language: it moves session state,
    control flow, or the line's own streams, and never reaches a backend
    except through the op dispatcher. ``TOOL`` is a program the line
    invokes that a real system ships as a separate binary, or that
    reaches beyond the session (an interpreter, the job table, the
    history recording). The permission layer exempts grammar from a
    command allowlist and treats tools as its subjects; both tiers stay
    deniable by name.
    """
    GRAMMAR = "grammar"
    TOOL = "tool"


class BuiltinGroup(StrEnum):
    """The family a shell builtin belongs to, one level below the tier.

    Every group sits in exactly one tier (``GROUP_TIER``), so filing a
    word in a group also files its tier; ``BUILTIN_GROUP`` is the one
    row per word. A listing (bare ``man``) or a rule can name a group
    where it would otherwise have to spell out the words.
    """
    # grammar
    WORKING_DIRECTORY = "working-directory"
    VARIABLES = "variables"
    SHELL_STATE = "shell-state"
    CONDITIONS = "conditions"
    OUTPUT = "output"
    RUNNING_LINES = "running-lines"
    NAME_LOOKUP = "name-lookup"
    CONTROL_FLOW = "control-flow"
    # tools
    ENVIRONMENT = "environment"
    MANUALS_AND_HISTORY = "manuals-and-history"
    JOB_CONTROL = "job-control"
    CLOCK = "clock"
    NESTED_SHELLS = "nested-shells"
    INTERPRETERS = "interpreters"
    COMMAND_RUNNERS = "command-runners"


GROUP_TIER: Mapping[BuiltinGroup, BuiltinTier] = {
    BuiltinGroup.WORKING_DIRECTORY: BuiltinTier.GRAMMAR,
    BuiltinGroup.VARIABLES: BuiltinTier.GRAMMAR,
    BuiltinGroup.SHELL_STATE: BuiltinTier.GRAMMAR,
    BuiltinGroup.CONDITIONS: BuiltinTier.GRAMMAR,
    BuiltinGroup.OUTPUT: BuiltinTier.GRAMMAR,
    BuiltinGroup.RUNNING_LINES: BuiltinTier.GRAMMAR,
    BuiltinGroup.NAME_LOOKUP: BuiltinTier.GRAMMAR,
    BuiltinGroup.CONTROL_FLOW: BuiltinTier.GRAMMAR,
    BuiltinGroup.ENVIRONMENT: BuiltinTier.TOOL,
    BuiltinGroup.MANUALS_AND_HISTORY: BuiltinTier.TOOL,
    BuiltinGroup.JOB_CONTROL: BuiltinTier.TOOL,
    BuiltinGroup.CLOCK: BuiltinTier.TOOL,
    BuiltinGroup.NESTED_SHELLS: BuiltinTier.TOOL,
    BuiltinGroup.INTERPRETERS: BuiltinTier.TOOL,
    BuiltinGroup.COMMAND_RUNNERS: BuiltinTier.TOOL,
}

# One row per ShellBuiltin. tests/shell/test_types.py pins that the rows
# cover the enum, that every group is used, and that the tier sets below
# are the rows' partition, so a new member has to be filed here on
# purpose.
BUILTIN_GROUP: Mapping[ShellBuiltin, BuiltinGroup] = {
    ShellBuiltin.PWD: BuiltinGroup.WORKING_DIRECTORY,
    ShellBuiltin.CD: BuiltinGroup.WORKING_DIRECTORY,
    ShellBuiltin.EXPORT: BuiltinGroup.VARIABLES,
    ShellBuiltin.UNSET: BuiltinGroup.VARIABLES,
    ShellBuiltin.LOCAL: BuiltinGroup.VARIABLES,
    ShellBuiltin.DECLARE: BuiltinGroup.VARIABLES,
    ShellBuiltin.TYPESET: BuiltinGroup.VARIABLES,
    ShellBuiltin.READONLY: BuiltinGroup.VARIABLES,
    ShellBuiltin.SET: BuiltinGroup.VARIABLES,
    ShellBuiltin.READ: BuiltinGroup.VARIABLES,
    ShellBuiltin.MAPFILE: BuiltinGroup.VARIABLES,
    ShellBuiltin.READARRAY: BuiltinGroup.VARIABLES,
    ShellBuiltin.SHIFT: BuiltinGroup.VARIABLES,
    ShellBuiltin.GETOPTS: BuiltinGroup.VARIABLES,
    ShellBuiltin.LET: BuiltinGroup.VARIABLES,
    ShellBuiltin.TRAP: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.SHOPT: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.UMASK: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.ALIAS: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.UNALIAS: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.EXEC: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.TEST: BuiltinGroup.CONDITIONS,
    ShellBuiltin.BRACKET: BuiltinGroup.CONDITIONS,
    ShellBuiltin.DOUBLE_BRACKET: BuiltinGroup.CONDITIONS,
    ShellBuiltin.ECHO: BuiltinGroup.OUTPUT,
    ShellBuiltin.PRINTF: BuiltinGroup.OUTPUT,
    ShellBuiltin.SOURCE: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.DOT: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.EVAL: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.COMMAND: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.TYPE: BuiltinGroup.NAME_LOOKUP,
    ShellBuiltin.WHICH: BuiltinGroup.NAME_LOOKUP,
    ShellBuiltin.TRUE: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.FALSE: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.COLON: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.BREAK: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.CONTINUE: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.RETURN: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.EXIT: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.PRINTENV: BuiltinGroup.ENVIRONMENT,
    ShellBuiltin.ENV: BuiltinGroup.ENVIRONMENT,
    ShellBuiltin.WHOAMI: BuiltinGroup.ENVIRONMENT,
    ShellBuiltin.MAN: BuiltinGroup.MANUALS_AND_HISTORY,
    ShellBuiltin.HISTORY: BuiltinGroup.MANUALS_AND_HISTORY,
    ShellBuiltin.WAIT: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.FG: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.KILL: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.JOBS: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.DISOWN: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.PS: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.SLEEP: BuiltinGroup.CLOCK,
    ShellBuiltin.BASH: BuiltinGroup.NESTED_SHELLS,
    ShellBuiltin.SH: BuiltinGroup.NESTED_SHELLS,
    ShellBuiltin.PYTHON: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.PYTHON3: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.NODE: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.JS: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.XARGS: BuiltinGroup.COMMAND_RUNNERS,
    ShellBuiltin.TIMEOUT: BuiltinGroup.COMMAND_RUNNERS,
}

GRAMMAR_BUILTINS: frozenset[ShellBuiltin] = frozenset(
    b for b, g in BUILTIN_GROUP.items()
    if GROUP_TIER[g] is BuiltinTier.GRAMMAR)

TOOL_BUILTINS: frozenset[ShellBuiltin] = frozenset(
    b for b, g in BUILTIN_GROUP.items() if GROUP_TIER[g] is BuiltinTier.TOOL)
