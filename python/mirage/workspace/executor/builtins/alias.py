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

import re

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.types import SHOPT_DEFAULTS
from mirage.utils.quote import single_quote
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.builtins.shared import fail
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_ALIAS_USAGE = "alias: usage: alias [-p] [name[=value] ... ]"
_UNALIAS_USAGE = "unalias: usage: unalias [-a] name [name ...]"

# bash's `legal_alias_name`: a shell metacharacter, a quote, `/`, `$`
# or a backtick anywhere in the name makes it unusable, since the parser
# would never read such a word as one command name.
_BAD_NAME_CHARS = frozenset(" \t\n/=$`'\"|&;()<>")

_FIRST_WORD = re.compile(r"\S+")

AliasMark = tuple[int, int]


async def handle_alias(
    args: list[str],
    session: Session,
    mark: AliasMark,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Define or print aliases.

    `alias` alone (or `-p`) prints every definition as a re-readable
    `alias NAME='VALUE'` line, sorted by name; `NAME=VALUE` defines,
    `NAME` prints that one or says `not found` (exit 1, the others
    still answered); a name holding a metacharacter is `invalid alias
    name`, exit 1. Any option but `-p` is exit 2 with the usage line.

    Args:
        args (list[str]): the words after `alias`.
        session (Session): shell session state.
        mark (AliasMark): the parse and row this definition sits on,
            which is what decides whether a later use on the same line
            sees it (bash expands aliases as it reads a line, so a use
            on the defining line does not).
    """
    scan = scan_options(args, "p")
    if scan.bad is not None:
        return fail(
            "alias",
            f"bash: alias: {scan.bad}: invalid option\n{_ALIAS_USAGE}\n", 2)
    operands = scan.operands
    lines: list[str] = []
    errors: list[str] = []
    if not operands or "p" in scan.letters:
        lines.extend(f"alias {name}={single_quote(session.aliases[name])}"
                     for name in sorted(session.aliases))
    for word in operands:
        name, eq, value = word.partition("=")
        if eq:
            if not name or any(c in _BAD_NAME_CHARS for c in name):
                # bash quotes the whole word for an empty name (`alias
                # =x` is `=x: not found`, oddly) and the name otherwise.
                if not name:
                    errors.append(f"bash: alias: {word}: not found")
                else:
                    errors.append(f"bash: alias: `{name}': invalid alias name")
                continue
            session.aliases[name] = value
            session._alias_marks[name] = mark
            continue
        if any(c in _BAD_NAME_CHARS for c in name):
            errors.append(f"bash: alias: `{name}': invalid alias name")
            continue
        if name in session.aliases:
            lines.append(f"alias {name}={single_quote(session.aliases[name])}")
        else:
            errors.append(f"bash: alias: {name}: not found")
    out = ("\n".join(lines) + "\n").encode() if lines else None
    err = ("\n".join(errors) + "\n").encode() if errors else None
    code = 1 if errors else 0
    return out, IOResult(exit_code=code,
                         stderr=err), ExecutionNode(command="alias",
                                                    exit_code=code,
                                                    stderr=err or b"")


async def handle_unalias(
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Remove aliases: the named ones, or all of them under `-a`.

    A name that is not an alias is `not found`, exit 1, and the others
    are still removed; no operand and no `-a` is the usage line, exit 2.

    Args:
        args (list[str]): the words after `unalias`.
        session (Session): shell session state.
    """
    scan = scan_options(args, "a")
    if scan.bad is not None:
        return fail(
            "unalias",
            f"bash: unalias: {scan.bad}: invalid option\n{_UNALIAS_USAGE}\n",
            2)
    operands = scan.operands
    if "a" in scan.letters:
        session.aliases.clear()
        session._alias_marks.clear()
        return None, IOResult(), ExecutionNode(command="unalias", exit_code=0)
    if not operands:
        return fail("unalias", f"{_UNALIAS_USAGE}\n", 2)
    errors: list[str] = []
    for name in operands:
        if name in session.aliases:
            del session.aliases[name]
            session._alias_marks.pop(name, None)
        else:
            errors.append(f"bash: unalias: {name}: not found")
    err = ("\n".join(errors) + "\n").encode() if errors else None
    code = 1 if errors else 0
    return None, IOResult(exit_code=code, stderr=err
                          or b""), ExecutionNode(command="unalias",
                                                 exit_code=code,
                                                 stderr=err or b"")


def alias_value(session: Session, name: str, mark: AliasMark) -> str | None:
    """The alias text a command word expands to, or None.

    None when aliases are not being expanded (`shopt -s expand_aliases`
    is off, bash's default outside an interactive shell), when the word
    is not an alias, when it is the alias being expanded (bash does not
    expand a word identical to an alias being expanded a second time),
    or when it was defined on the very parse and row that uses it.

    Args:
        session (Session): shell session state.
        name (str): the command word.
        mark (AliasMark): the parse and row of the use.
    """
    if not session.shopts.get("expand_aliases",
                              SHOPT_DEFAULTS["expand_aliases"]):
        return None
    value = session.aliases.get(name)
    if value is None or name in session._alias_stack:
        return None
    if session._alias_marks.get(name) == mark:
        return None
    return value


def alias_command_text(session: Session, name: str, rest: str,
                       mark: AliasMark) -> str | None:
    """The command line an aliased head word rewrites to, or None.

    The alias text replaces the word; a value ending in a blank asks for
    the next word to be checked as an alias too, which is bash's rule
    for `alias sudo='sudo '`. Whatever comes back is a fresh line the
    parser reads again, so a value holding a pipe or a redirection is a
    pipe or a redirection.

    Args:
        session (Session): shell session state.
        name (str): the head word.
        rest (str): the source text after the head word, as typed.
        mark (AliasMark): the parse and row of the use.
    """
    value = alias_value(session, name, mark)
    if value is None:
        return None
    seen = {name}
    out = value
    while out.endswith((" ", "\t")):
        stripped = rest.lstrip()
        match = _FIRST_WORD.match(stripped)
        if match is None or match.group(0) in seen:
            break
        nxt = alias_value(session, match.group(0), mark)
        if nxt is None:
            break
        seen.add(match.group(0))
        out += nxt
        rest = stripped[match.end():]
    tail = rest.strip()
    return f"{out} {tail}" if tail else out
