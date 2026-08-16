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
class ElementWrite:
    """One array-element assignment an arithmetic evaluation produced.

    Args:
        name (str): the array variable's name.
        key (str): the canonical subscript ``ElementOps.resolve`` gave.
        value (str): the stored decimal text.
    """
    name: str
    key: str
    value: str


@dataclass(frozen=True, slots=True)
class ArithResult:
    """What one arithmetic evaluation produced.

    Args:
        value (int): the expression's value.
        updates (dict[str, str]): scalar assignments made, name to
            decimal text, for the caller to land through the session
            door.
        element_updates (tuple[ElementWrite, ...]): element assignments
            made, in evaluation order, for the caller to land the same
            way.
    """
    value: int
    updates: dict[str, str]
    element_updates: tuple[ElementWrite, ...] = ()


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
    to mounts.
    """
    # session state
    PWD = "pwd"
    CD = "cd"
    EXPORT = "export"
    UNSET = "unset"
    LOCAL = "local"
    SET = "set"
    PRINTENV = "printenv"
    ENV = "env"
    WHOAMI = "whoami"
    MAN = "man"
    HISTORY = "history"
    # control
    TRUE = "true"
    FALSE = "false"
    COLON = ":"
    SOURCE = "source"
    DOT = "."
    EVAL = "eval"
    READ = "read"
    SHIFT = "shift"
    GETOPTS = "getopts"
    TRAP = "trap"
    TEST = "test"
    BRACKET = "["
    DOUBLE_BRACKET = "[["
    # job control
    WAIT = "wait"
    FG = "fg"
    KILL = "kill"
    JOBS = "jobs"
    PS = "ps"
    # output / text processing (no filesystem)
    ECHO = "echo"
    PRINTF = "printf"
    SLEEP = "sleep"
    # nested shells
    BASH = "bash"
    SH = "sh"
    # python exec
    PYTHON = "python"
    PYTHON3 = "python3"
    # javascript exec
    NODE = "node"
    JS = "js"
    # commands handled by executor
    XARGS = "xargs"
    TIMEOUT = "timeout"
    COMMAND = "command"
    TYPE = "type"
    WHICH = "which"
    BREAK = "break"
    CONTINUE = "continue"
    RETURN = "return"
    EXIT = "exit"
