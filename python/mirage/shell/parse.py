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

import tree_sitter
import tree_sitter_bash

from mirage.io import IOResult

BASH_LANGUAGE = tree_sitter.Language(tree_sitter_bash.language())
TS_PARSER = tree_sitter.Parser(BASH_LANGUAGE)

ARITH_OPEN_TOKEN = "(("
_QUOTES = (b"'", b'"')


def _balanced_end(data: bytes, start: int) -> int | None:
    """Index just past the ``)`` closing the ``(`` at ``start``.

    Parens inside quotes and backslash escapes do not count, so a
    command substitution or a literal ``")"`` cannot throw off the
    depth. Scanned as bytes because tree-sitter reports byte offsets;
    the delimiters are all ASCII, so multibyte characters pass through
    without matching anything.

    Args:
        data (bytes): encoded shell source.
        start (int): byte offset of the opening paren.

    Returns:
        int | None: end offset, or None when the parens never balance.
    """
    depth = 0
    index = start
    quote: bytes | None = None
    while index < len(data):
        char = data[index:index + 1]
        if quote is not None:
            if char == b"\\" and quote == b'"':
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in _QUOTES:
            quote = char
        elif char == b"\\":
            index += 2
            continue
        elif char == b"(":
            depth += 1
        elif char == b")":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def _is_arithmetic(data: bytes, start: int) -> bool:
    """Whether the construct at ``start`` is a real arithmetic command.

    Decided by parsing the balanced span on its own: ``((i++))`` stands
    alone cleanly, while ``((echo x); echo $i)`` does not. Judging each
    opener separately is what keeps a valid ``((i++))`` safe when it
    shares a line with a broken one, since tree-sitter's error region
    covers both.

    Args:
        data (bytes): encoded shell source.
        start (int): byte offset of the opener's first paren.
    """
    end = _balanced_end(data, start)
    if end is None:
        # Unbalanced: no span to judge, so assume arithmetic and leave
        # the construct alone rather than risk rewriting it.
        return True
    return not TS_PARSER.parse(data[start:end]).root_node.has_error


def _failed_arith_openers(root: tree_sitter.Node) -> list[int]:
    """Byte offsets of ``((`` tokens the parser could not make sense of.

    Only openers inside an ERROR subtree are reported. A genuine
    ``((i++))`` parses as an arithmetic command and never lands in one,
    so it cannot be picked up here.

    Args:
        root (tree_sitter.Node): root of a tree that has an error.
    """
    offsets: list[int] = []
    stack: list[tuple[tree_sitter.Node, bool]] = [(root, False)]
    while stack:
        node, in_error = stack.pop()
        errored = in_error or node.type == "ERROR"
        if errored and node.type == ARITH_OPEN_TOKEN:
            offsets.append(node.start_byte)
        for child in node.children:
            stack.append((child, errored))
    return offsets


def strip_line_continuation(command: str) -> str:
    """Drop a trailing backslash that continues the line, as bash does.

    The reader removes ``\\<newline>`` before the parser ever sees it, and
    a backslash ending the input is the same thing with nothing left to
    continue onto: ``echo a\\`` runs ``echo a``. Only an odd-length run
    of trailing backslashes ends in a live one, since each earlier pair
    is an escaped backslash (``echo a\\\\`` keeps its literal backslash).

    Args:
        command (str): the raw command line.
    """
    stripped = command.rstrip("\\")
    if (len(command) - len(stripped)) % 2 == 1:
        return command[:-1]
    return command


def find_unterminated_backtick(command: str) -> str | None:
    """Locate a backtick substitution that is never closed.

    tree-sitter happily parses ``echo `echo a`` as a complete command,
    so the region has to be scanned directly. Quoting follows the shell
    reader: single quotes protect a backtick, double quotes do not, and
    once inside a substitution only a backslash escapes, which is why
    ``"`echo '`'`"`` is an error in bash rather than a quoted backtick.

    Args:
        command (str): the raw command line.

    Returns:
        str | None: text from the unmatched backtick on, or None.
    """
    quote: str | None = None
    dollar_quote = False
    opened: int | None = None
    last_dollar = -2
    i = 0
    while i < len(command):
        ch = command[i]
        if quote == "'":
            # $'...' takes backslash escapes, so \' does not close it;
            # a plain '...' treats every backslash literally.
            if dollar_quote and ch == "\\":
                i += 2
                continue
            if ch == "'":
                quote = None
                dollar_quote = False
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if opened is not None:
            if ch == "`":
                opened = None
            i += 1
            continue
        if ch == "`":
            opened = i
        elif ch == "'" and quote is None:
            quote = "'"
            dollar_quote = last_dollar == i - 1
        elif ch == '"':
            quote = None if quote == '"' else '"'
        elif ch == "$":
            last_dollar = i
        i += 1
    return command[opened:] if opened is not None else None


_NAME_CONT = frozenset(
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
_DIGITS = frozenset(b"0123456789")


def _orphaned_dollar_offsets(root: tree_sitter.Node, data: bytes) -> list[int]:
    """Byte offsets of literal ``$`` tokens cut off from their name.

    tree-sitter-bash 0.25.1 stops lexing a later unbraced expansion in a
    word when a name-terminating character follows it, so
    ``> /api/$c/$id.json`` parses as ``/api/$c/$`` plus a sibling word
    ``id.json``: the ``$`` lands in the tree as a literal token and the
    expansion is gone. A literal ``$`` directly followed by a name
    character is a shape no correct bash lex produces (bash would have
    read an expansion), so each one marks a mis-parse. The ``$`` opening
    a simple_expansion is that expansion's own token and is skipped.

    Args:
        root (tree_sitter.Node): root of the parsed tree.
        data (bytes): the source the tree was parsed from.
    """
    offsets: list[int] = []
    stack = [root]
    while stack:
        node = stack.pop()
        for child in node.children:
            if (not child.is_named and child.type == "$"
                    and node.type != "simple_expansion"
                    and data[child.end_byte:child.end_byte + 1]
                    and data[child.end_byte] in _NAME_CONT):
                offsets.append(child.start_byte)
            stack.append(child)
    return offsets


def _rebrace_dollar(data: bytes, offset: int) -> bytes:
    """Rewrite the expansion at ``offset`` into its braced spelling.

    ``$id.json`` becomes ``${id}.json``, which says the same thing and
    is the spelling the grammar reads correctly. Bash reads a single
    digit after ``$`` as one positional parameter, so ``$12`` rebraces
    as ``${1}2``.

    Args:
        data (bytes): shell source holding the orphaned ``$``.
        offset (int): byte offset of the ``$``.
    """
    end = offset + 1
    if data[end] in _DIGITS:
        end += 1
    else:
        while end < len(data) and data[end] in _NAME_CONT:
            end += 1
    return data[:offset] + b"${" + data[offset + 1:end] + b"}" + data[end:]


def _repair_orphaned_dollars(root: tree_sitter.Node,
                             data: bytes) -> tree_sitter.Node:
    """Rebrace mis-lexed expansions and reparse until none remain.

    Every rebrace consumes one bare ``$`` and never writes a new one,
    so the loop is bounded by the count of ``$`` bytes. A retry that
    parses worse than what it replaces is discarded.

    Args:
        root (tree_sitter.Node): tree parsed from ``data``.
        data (bytes): the source ``root`` was parsed from.
    """
    for _ in range(data.count(b"$")):
        offsets = _orphaned_dollar_offsets(root, data)
        if not offsets:
            break
        for offset in sorted(offsets, reverse=True):
            data = _rebrace_dollar(data, offset)
        retried = TS_PARSER.parse(data).root_node
        if retried.has_error:
            break
        root = retried
    return root


def parse(command: str) -> tree_sitter.Node:
    """Parse a shell command string into a tree-sitter AST.

    A leading ``((`` is lexed as the arithmetic opener and the lexer
    cannot back out, so a subshell that immediately opens another
    subshell (``((echo a); echo b)``) fails to parse. Bash resolves the
    same ambiguity by trying the arithmetic command and reparsing as
    nested subshells when that fails; this does the same, splitting only
    the openers that already sit inside an error and keeping the retry
    only if it parses cleanly. Commands that parse today are untouched,
    so no working command's byte offsets move.

    A later unbraced ``$var`` followed by a name-terminating character
    is mis-lexed by the grammar, leaving a literal ``$`` token behind
    (see _orphaned_dollar_offsets); those expansions are rebraced and
    the line reparsed, so the returned tree can spell ``$id`` as
    ``${id}``.

    Args:
        command (str): shell source to parse.

    Returns:
        tree_sitter.Node: root node, or the original errored root when no
        reparse helps.
    """
    data = strip_line_continuation(command).encode()
    root = TS_PARSER.parse(data).root_node
    if root.has_error:
        # Sitting inside an ERROR is not evidence that an opener is
        # broken: tree-sitter's error region swallows neighbouring
        # tokens, so a valid `((i++))` next to a bad opener reports as
        # errored too. Splitting it would silently turn arithmetic into
        # a subshell running `i++`, which is a wrong parse rather than a
        # rejected one. Each opener is judged on its own span instead,
        # in byte space throughout, because the offsets tree-sitter
        # reports are byte offsets.
        offsets = [
            offset for offset in set(_failed_arith_openers(root))
            if not _is_arithmetic(data, offset)
        ]
        if offsets:
            retried_data = data
            for offset in sorted(offsets, reverse=True):
                retried_data = (retried_data[:offset + 1] + b" " +
                                retried_data[offset + 1:])
            retried = TS_PARSER.parse(retried_data).root_node
            if not retried.has_error:
                root = retried
                data = retried_data
    if b"$" in data:
        root = _repair_orphaned_dollars(root, data)
    return root


_BASH_KEYWORDS = frozenset({
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "in",
    "function",
    "select",
})

_STRUCTURAL_TOKENS = frozenset({
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    '"',
    "'",
    "`",
})


def _is_structural_error(node: tree_sitter.Node) -> bool:
    """True if an ERROR node represents a real syntactic problem.

    Tree-sitter occasionally emits ERROR nodes for stray statement
    separators that bash itself accepts (notably ``& ;``). A real
    syntax error contains a bash keyword, a bracket / quote token,
    or a named subtree the parser tried to recover; stand-alone
    statement separators (``;``, ``&``, ``|``) are not enough.
    """
    for child in node.children:
        if child.is_named:
            return True
        if child.type in _BASH_KEYWORDS:
            return True
        if child.type in _STRUCTURAL_TOKENS:
            return True
    return False


def _walk_named(node: tree_sitter.Node):
    yield node
    for child in node.named_children:
        yield from _walk_named(child)


def _is_recovered_quoted_heredoc_end(previous: tree_sitter.Node | None,
                                     error: tree_sitter.Node) -> bool:
    if previous is None:
        return False
    error_text = (error.text or b"").decode().strip()
    if not error_text:
        return False
    for candidate in _walk_named(previous):
        if candidate.type != "heredoc_redirect":
            continue
        start = None
        end = None
        for child in candidate.named_children:
            if child.type == "heredoc_start":
                start = (child.text or b"").decode()
            elif child.type == "heredoc_end":
                end = (child.text or b"").decode()
        if (start is not None and ("'" in start or '"' in start) and not end
                and start.replace("'", "").replace('"', "") == error_text):
            return True
    return False


def find_syntax_error(node: tree_sitter.Node) -> str | None:
    """Locate a top-level structural syntax error in a parsed AST.

    Args:
        node (tree_sitter.Node): root node from parse().

    Returns:
        str | None: text of the offending region, or None if the AST is clean.
    """
    if not node.has_error:
        return None
    previous = None
    for child in node.children:
        if child.is_missing:
            text = child.text
            return text.decode(errors="replace") if text else ""
        if child.type == "ERROR" and _is_structural_error(child):
            if _is_recovered_quoted_heredoc_end(previous, child):
                previous = child
                continue
            text = child.text
            return text.decode(errors="replace") if text else ""
        if child.is_named:
            previous = child
    return None


def syntax_error_result(offending: str) -> IOResult:
    """Exit 2 with the bash-style diagnostic for an unparsable line.

    Args:
        offending (str): the span the parser flagged.
    """
    snippet = offending.strip()
    err = (f"mirage: syntax error near {snippet!r}\n".encode()
           if snippet else b"mirage: syntax error in command\n")
    return IOResult(exit_code=2, stderr=err)


# Where a `variable_name` node is a write target rather than a read:
# the assignment's name and the for loop's variable. Everything else --
# expansions, arithmetic, subscripts -- reads the name.
_TARGET_NAME_FIELDS = {
    "variable_assignment": "name",
    "for_statement": "variable",
}

# Nodes whose bare `variable_name` children declare or delete a name
# (`readonly R`, `export Z`, `unset X`); their assignment children still
# carry reads and are walked.
_DECLARING_NODES = frozenset({"declaration_command", "unset_command"})


def _collect_names(node: tree_sitter.Node, out: set[str]) -> None:
    if node.type == "variable_name":
        text = node.text
        if text:
            out.add(text.decode())
        return
    if node.type in _DECLARING_NODES:
        for child in node.children:
            if child.type != "variable_name":
                _collect_names(child, out)
        return
    field = _TARGET_NAME_FIELDS.get(node.type)
    target = node.child_by_field_name(field) if field else None
    for child in node.children:
        if target is not None and child.id == target.id:
            continue
        _collect_names(child, out)


def referenced_names(node: tree_sitter.Node) -> frozenset[str]:
    """Every variable name a parsed program may read.

    A textual over-approximation over the whole tree, which is safe by
    construction: the worst a spurious name costs is one fetch. Walked
    everywhere -- command substitution bodies, redirect targets,
    heredoc bodies, arithmetic -- with two exceptions that are writes,
    not reads (an assignment's own name, a for loop's variable), and
    one the grammar gives for free: a single-quoted string tokenizes as
    `raw_string` with no children, so `'$X'` never reads X.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    _collect_names(node, out)
    return frozenset(out)


def command_words(node: tree_sitter.Node) -> frozenset[str]:
    """The first word of every command in a parsed program.

    What the whole-env table and the CLI env-name lookup key on.
    `command_name` covers ordinary commands wherever they sit; the
    declaring builtins (`export`, `declare`, `local`, `readonly`,
    `unset`) parse as their own node types whose head word is the
    first anonymous token, so those are read directly.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    for n in _walk_named(node):
        if n.type == "command_name":
            text = n.text
            if text:
                out.add(text.decode())
        elif n.type in _DECLARING_NODES and n.children:
            text = n.children[0].text
            if text:
                out.add(text.decode())
    return frozenset(out)
