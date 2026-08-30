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
    if node.type == "function_definition":
        return
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


def _walk_named_outside_defs(node: tree_sitter.Node):
    """Named nodes, skipping function_definition subtrees.

    A definition's body runs at invocation, not where it is defined,
    so a read walk that descended into one would charge the defining
    line for reads it never performs. The fill layer joins invoked
    bodies back in through its own node set (``line_nodes``).

    Args:
        node (tree_sitter.Node): subtree root.
    """
    if node.type == "function_definition":
        return
    yield node
    for child in node.named_children:
        yield from _walk_named_outside_defs(child)


def referenced_names(node: tree_sitter.Node) -> frozenset[str]:
    """Every variable name a parsed program may read when it runs.

    A textual over-approximation over the whole tree, which is safe by
    construction: the worst a spurious name costs is one fetch. Walked
    everywhere -- command substitution bodies, redirect targets,
    heredoc bodies, arithmetic -- with two exceptions that are writes,
    not reads (an assignment's own name, a for loop's variable), one
    that runs later rather than now (a function definition's body,
    which the fill layer joins back in at invocation), and one the
    grammar gives for free: a single-quoted string tokenizes as
    `raw_string` with no children, so `'$X'` never reads X.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    _collect_names(node, out)
    return frozenset(out)


def command_words(node: tree_sitter.Node) -> frozenset[str]:
    """The first word of every command a parsed program runs.

    What the whole-env scan and the CLI env-name lookup key on.
    `command_name` covers ordinary commands wherever they sit; the
    declaring builtins (`export`, `declare`, `local`, `readonly`,
    `unset`) parse as their own node types whose head word is the
    first anonymous token, so those are read directly. A function
    definition's body is skipped: those commands run at invocation,
    where the fill layer walks the stored body instead.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    for n in _walk_named_outside_defs(node):
        if n.type == "command_name":
            text = n.text
            if text:
                out.add(text.decode())
        elif n.type in _DECLARING_NODES and n.children:
            text = n.children[0].text
            if text:
                out.add(text.decode())
    return frozenset(out)


# The declaring builtins whose bare invocation prints the environment
# (`export`, `export -p`, `declare`); `local` prints only a function's
# locals and `readonly` only the read-only set, neither of which a
# managed entry can be.
_DECL_PRINTER_HEADS = frozenset({"export", "declare", "typeset"})

# The declaring builtins whose `-n` makes the operand a nameref.
# `export -n` and `unset -n` mean other things and are not these.
_NAMEREF_HEADS = frozenset({"declare", "typeset", "local"})


def _literal_text(node: tree_sitter.Node) -> str | None:
    """The argument's text when the parser fixed it, else None.

    A plain word, a number, a raw string and a double-quoted string of
    plain content each spell one literal; anything carrying an
    expansion or a substitution is dynamic and reads as None.

    Args:
        node (tree_sitter.Node): an argument node of a command.
    """
    if node.type in ("word", "number"):
        text = node.text
        return text.decode() if text else None
    if node.type == "raw_string":
        text = node.text
        return text.decode()[1:-1] if text else None
    if node.type == "string":
        named = node.named_children
        if not named:
            return ""
        if len(named) == 1 and named[0].type == "string_content":
            text = named[0].text
            return text.decode() if text else ""
    return None


def _declaration_parts(
        node: tree_sitter.Node
) -> tuple[str, list[str], list[tree_sitter.Node]]:
    """Split a declaration_command into head word, flag words, operands.

    Args:
        node (tree_sitter.Node): a ``declaration_command`` node.
    """
    head = ""
    if node.children:
        text = node.children[0].text
        head = text.decode() if text else ""
    flags: list[str] = []
    operands: list[tree_sitter.Node] = []
    for child in node.children[1:]:
        if child.type == "word":
            text = child.text
            word = text.decode() if text else ""
            if word.startswith("-"):
                flags.append(word)
            else:
                operands.append(child)
        elif child.is_named:
            operands.append(child)
    return head, flags, operands


def _flag_has(flags: list[str], letter: str) -> bool:
    """Whether a single-dash flag word carries the letter.

    Args:
        flags (list[str]): flag words as typed (``-p``, ``-nr``).
        letter (str): the option letter looked for.
    """
    return any(
        flag.startswith("-") and not flag.startswith("--")
        and letter in flag[1:] for flag in flags)


def _command_args(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    """A command node's argument children: no name, prefixes, redirects.

    Args:
        node (tree_sitter.Node): a ``command`` node.
    """
    name_node = node.child_by_field_name("name")
    return [
        child for child in node.named_children
        if (name_node is None or child.id != name_node.id) and child.type !=
        "variable_assignment" and not child.type.endswith("_redirect")
    ]


def _env_exclusions(args: list[tree_sitter.Node]) -> frozenset[str] | None:
    """Names an ``env`` invocation provably keeps from the environment
    it hands on: None when it reads no existing name at all, else the
    set a whole-environment read may skip.

    Scanned with the builtin's own option grammar: ``--`` ends the
    options, ``-u``/``--unset`` consume a value (so ``-u -i`` unsets a
    variable named ``-i`` rather than clearing) and add it to the
    exclusions, the leading ``NAME=VALUE`` operands override and
    exclude their names, and the first other operand ends the scan.
    ``-i``, ``--ignore-environment`` or the lone ``-`` empties the
    start entirely, and an option the builtin refuses stops it from
    running at all; both answer None. The scan is left to right like
    the builtin's, so everything consumed before the first word no
    static read can spell keeps its effect whatever that word turns
    out to be, and nothing after it is claimed: a dynamic word may be
    the command, demoting every later word to an argument.

    Args:
        args (list[tree_sitter.Node]): the invocation's argument nodes.
    """
    excluded: set[str] = set()
    i = 0
    while i < len(args):
        literal = _literal_text(args[i])
        if literal is None:
            return frozenset(excluded)
        if literal == "--":
            i += 1
            break
        if literal in ("-i", "--ignore-environment", "-"):
            return None
        if literal == "--unset":
            if i + 1 >= len(args):
                return None
            value = _literal_text(args[i + 1])
            if value is not None:
                excluded.add(value)
            i += 2
            continue
        if literal.startswith("--unset="):
            excluded.add(literal[len("--unset="):])
            i += 1
            continue
        if literal in ("-0", "--null"):
            i += 1
            continue
        if literal.startswith("--"):
            return None
        if literal.startswith("-") and len(literal) > 1:
            step = 1
            for pos, ch in enumerate(literal[1:]):
                if ch == "i":
                    return None
                if ch == "u":
                    rest = literal[pos + 2:]
                    if rest:
                        excluded.add(rest)
                    elif i + 1 < len(args):
                        value = _literal_text(args[i + 1])
                        if value is not None:
                            excluded.add(value)
                        step = 2
                    else:
                        return None
                    break
                if ch != "0":
                    return None
            i += step
            continue
        break
    while i < len(args):
        literal = _literal_text(args[i])
        if literal is None:
            return frozenset(excluded)
        if "=" not in literal or literal.startswith("="):
            break
        excluded.add(literal.partition("=")[0])
        i += 1
    return frozenset(excluded)


def _prefix_assignment_names(node: tree_sitter.Node) -> frozenset[str]:
    """Names a command's assignment prefixes provably override.

    ``TOKEN=local printenv TOKEN`` hands the command an environment
    whose TOKEN is the override, so an environment read through that
    invocation cannot observe the standing value whatever the override
    expands to; the value's own reads are the walk's business. ``+=``
    appends to the standing value and proves nothing.

    Args:
        node (tree_sitter.Node): a ``command`` node.
    """
    out: set[str] = set()
    for child in node.named_children:
        if child.type != "variable_assignment":
            continue
        if any(part.type == "+=" for part in child.children):
            continue
        name_node = child.child_by_field_name("name")
        if name_node is None or name_node.type != "variable_name":
            continue
        text = name_node.text
        if text:
            out.add(text.decode())
    return frozenset(out)


def env_reads(
        node: tree_sitter.Node) -> tuple[bool, frozenset[str], frozenset[str]]:
    """How the line's environment-rendering commands read names.

    Returns ``(whole, names, excluded)``: whether some command renders
    the whole environment, the names printing forms read explicitly,
    and the names every whole-environment read provably skips. Only a
    printing form selects everything: ``env`` on any invocation (bare
    it prints every exported name, and with arguments it hands the
    snapshot to the command it runs) unless a literal ``-i``,
    ``--ignore-environment`` or lone ``-`` proves it starts empty, a
    bare ``set``, a bare ``printenv``, and a declaring builtin with no
    operands (``export``, ``declare -p``). ``printenv NAME`` and
    ``declare -p NAME`` read exactly the named variables, and a
    mutating form (``export NAME=v``, ``declare -x NAME``, ``set -u``)
    reads nothing here, so an unavailable source cannot fail the write
    that would replace its pointer. A print target no static read can
    spell (``printenv $x``) falls back to the whole environment.

    Exclusions are per invocation: an assignment prefix overrides its
    name for exactly that command's environment, and ``env``'s ``-u``,
    ``--unset`` and ``NAME=VALUE`` words remove or override theirs
    (``_env_exclusions``), so ``env -u TOKEN printenv TOKEN`` cannot
    observe TOKEN however the whole snapshot is handed on. A print
    target so excluded is dropped rather than reported. ``excluded``
    is the intersection across the node's whole-environment reads,
    because a name is skippable only when every such read skips it.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    whole = False
    excluded: frozenset[str] | None = None
    names: set[str] = set()
    for n in _walk_named_outside_defs(node):
        if n.type == "command":
            name_node = n.child_by_field_name("name")
            text = name_node.text if name_node is not None else None
            head = text.decode() if text else ""
            prefix = _prefix_assignment_names(n)
            skipped: frozenset[str] | None = None
            if head == "env":
                scanned = _env_exclusions(_command_args(n))
                if scanned is not None:
                    skipped = prefix | scanned
            elif head == "set":
                if not _command_args(n):
                    skipped = prefix
            elif head == "printenv":
                read_any = False
                for child in _command_args(n):
                    literal = _literal_text(child)
                    if literal is None:
                        skipped = prefix
                        read_any = True
                    elif not literal.startswith("-"):
                        if literal not in prefix:
                            names.add(literal)
                        read_any = True
                if not read_any:
                    skipped = prefix
            if skipped is not None:
                whole = True
                excluded = (skipped if excluded is None else excluded
                            & skipped)
        elif n.type == "declaration_command":
            head, flags, operands = _declaration_parts(n)
            if head not in _DECL_PRINTER_HEADS:
                continue
            selected = False
            if not operands:
                selected = True
            elif _flag_has(flags, "p"):
                for operand in operands:
                    if operand.type == "variable_name":
                        text = operand.text
                        if text:
                            names.add(text.decode())
                    elif operand.type != "variable_assignment":
                        selected = True
            if selected:
                whole = True
                excluded = frozenset()
    return whole, frozenset(names), excluded or frozenset()


def opaque_reads(node: tree_sitter.Node) -> bool:
    """Whether the line reads names no static walk can spell.

    Two constructs defeat ``referenced_names``: an indirect expansion
    (``${!name}`` reads the variable the *value* of ``name`` names, and
    the ``${!p*}``/``${!p@}`` forms enumerate by prefix), and a nameref
    declared on the line itself (``declare -n r=T; echo $r`` reads T
    before any session record says so). A nameref from an earlier line
    is not opaque: the session records its target, which ``deref``
    resolves.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    for n in _walk_named_outside_defs(node):
        if n.type == "expansion" and any(c.type == "!" for c in n.children):
            return True
        if n.type == "declaration_command":
            head, flags, _ = _declaration_parts(n)
            if head in _NAMEREF_HEADS and _flag_has(flags, "n"):
                return True
    return False


def command_invocations(
    node: tree_sitter.Node
) -> tuple[tuple[str | None, tuple[str | None, ...]], ...]:
    """Every plain command's head word with its argument words.

    Head and arguments are reported as their literal text, or None for
    a word no static read can spell (an expansion, a substitution), so
    a caller matching names (the CLI env-name pruning) can tell "this
    word is not there" from "this word is unknowable". A None head is
    the stronger fact: the command that runs is not decidable before
    expansion, so the fill pass treats the line as an opaque read.
    Assignment prefixes and redirects are not arguments.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: list[tuple[str | None, tuple[str | None, ...]]] = []
    for n in _walk_named_outside_defs(node):
        if n.type != "command":
            continue
        name_node = n.child_by_field_name("name")
        if name_node is None:
            continue
        inner = name_node.named_children
        head = _literal_text(inner[0]) if len(inner) == 1 else None
        args = tuple(_literal_text(child) for child in _command_args(n))
        out.append((head, args))
    return tuple(out)


# Names a builtin reads with no ``$NAME`` in the text: ``read`` splits
# its input on ``$IFS`` and ``getopts`` resumes from ``$OPTIND``.
# ``cd``'s names depend on the operand shape (``_cd_reads``).
_IMPLICIT_HEAD_READS: dict[str, frozenset[str]] = {
    "read": frozenset({"IFS"}),
    "getopts": frozenset({"OPTIND"}),
}

# A relative ``cd`` operand searches ``$CDPATH`` unless it is anchored
# (``/``, ``./``, ``../``) or a tilde the expansion anchors first;
# mirrors ``_cdpath_searchable`` in the cd builtin.
_CD_ANCHORS = ("/", "./", "../", "~")


def _cd_reads(args: tuple[str | None, ...]) -> frozenset[str]:
    """The names one ``cd`` invocation reads implicitly.

    Bare ``cd`` goes to ``$HOME``, ``cd -`` to ``$OLDPWD``, and a
    searchable relative operand tries ``$CDPATH`` first. Option words
    (``-L``/``-P``/``--``) are not operands, and a word no static read
    can spell may expand to any of the shapes, so it selects all three.

    Args:
        args (tuple[str | None, ...]): the invocation's argument words
            (``command_invocations``), None for a dynamic word.
    """
    operands: list[str] = []
    for arg in args:
        if arg is None:
            return frozenset({"HOME", "OLDPWD", "CDPATH"})
        if arg == "-" or not arg.startswith("-"):
            operands.append(arg)
    if not operands:
        return frozenset({"HOME"})
    target = operands[0]
    if target == "-":
        return frozenset({"OLDPWD"})
    if target.startswith(_CD_ANCHORS) or target in (".", ".."):
        return frozenset()
    return frozenset({"CDPATH"})


def implicit_reads(node: tree_sitter.Node) -> frozenset[str]:
    """Names the program reads without a ``$NAME`` in the text.

    Tilde expansion resolves ``~`` and ``~/...`` against ``$HOME``
    wherever a word expands (patterns and redirect targets included),
    and the word scan mirrors ``expand_tilde`` exactly: ``~user``, a
    mid-word tilde and a quoted one stay literal. ``cd`` reads
    ``$HOME`` bare, ``$OLDPWD`` for ``-`` and ``$CDPATH`` for a
    searchable relative operand; ``read`` splits on ``$IFS``;
    ``getopts`` resumes from ``$OPTIND``. These join the fill plan
    exactly as a spelled reference does, so a managed ``HOME`` fetches
    for ``echo ~`` the way it does for ``echo $HOME``.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    for n in _walk_named_outside_defs(node):
        if n.type == "word":
            text = n.text
            if text is not None and (text == b"~" or text.startswith(b"~/")):
                out.add("HOME")
    for head, args in command_invocations(node):
        reads = _IMPLICIT_HEAD_READS.get(head or "")
        if reads is not None:
            out |= reads
        if head == "cd":
            out |= _cd_reads(args)
    return frozenset(out)
