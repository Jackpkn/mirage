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

from mirage.commands.spec.shell import ECHO_OPTION
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.bytes import byte_char, encode_text
from mirage.shell.errors import ArithError
from mirage.workspace.executor.builtins.printf_format import run_printf
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element
from mirage.workspace.types import ExecutionNode

# A subscript must be non-empty: bash rejects `a[]` as an invalid
# identifier, while `a[ ]` is a valid arithmetic 0.
_PRINTF_TARGET_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(?:\[(.+)\])?\Z")

_SIMPLE_ESCAPES = {
    "\\": "\\",
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}

_HEX = set("0123456789abcdefABCDEF")

_OCT = set("01234567")


def _interpret_escapes(text: str) -> str:
    """Process C-style escape sequences for echo -e.

    Single-pass to handle \\\\ correctly (\\\\b → \\b literal).
    Supports: \\\\, \\n, \\t, \\r, \\a, \\b, \\f, \\v,
    \\xHH (hex), \\0NNN (octal), \\c (stop output).
    Unknown escapes like \\z pass through as \\z.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "\\" or i + 1 >= n:
            out.append(text[i])
            i += 1
            continue
        ch = text[i + 1]
        if ch in _SIMPLE_ESCAPES:
            out.append(_SIMPLE_ESCAPES[ch])
            i += 2
        elif ch == "c":
            break
        elif ch == "x":
            # \xHH — up to 2 hex digits
            digits: list[str] = []
            j = i + 2
            while j < n and len(digits) < 2 and text[j] in _HEX:
                digits.append(text[j])
                j += 1
            if digits:
                out.append(byte_char(int("".join(digits), 16)))
                i = j
            else:
                out.append("\\x")
                i += 2
        elif ch == "0":
            # \0NNN — up to 3 octal digits
            digits = []
            j = i + 2
            while j < n and len(digits) < 3 and text[j] in _OCT:
                digits.append(text[j])
                j += 1
            out.append(byte_char(int("".join(digits), 8)) if digits else "\0")
            i = j
        else:
            # unknown escape — pass through literally
            out.append("\\")
            out.append(ch)
            i += 2
    return "".join(out)


async def handle_echo(
        args: list[str],  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print arguments, honoring GNU echo's option rules.

    GNU echo is not getopt: options are LEADING words matching
    ``-[neE]+`` only. The first word that does not match (including
    ``-x`` or a repeated ``hi -n``) ends option parsing and prints
    literally. Within clusters the last of -e/-E wins; -n sticks.

    Args:
        args (list[str]): words after the command name, as typed.
    """
    no_newline = False
    escapes = False
    idx = 0
    for word in args:
        if not ECHO_OPTION.fullmatch(word):
            break
        for ch in word[1:]:
            if ch == "n":
                no_newline = True
            elif ch == "e":
                escapes = True
            else:
                escapes = False
        idx += 1
    text = " ".join(args[idx:])
    if escapes:
        text = _interpret_escapes(text)
    if not no_newline:
        text += "\n"
    out = encode_text(text)
    return out, IOResult(), ExecutionNode(command="echo", exit_code=0)


async def _assign_printf_target(session: Session, view: SessionView | None,
                                name: str, subscript: str | None,
                                value: str) -> str:
    """Assign ``value`` to a ``printf -v`` target (scalar or ``name[idx]``).

    A delegation to the one element writer: a bare name assigns element
    0 when the name already holds an array (indexed or associative),
    nothing mutates unless the whole assignment succeeds, and the
    landing write goes through the door as the whole variable, so a
    ``pre_session`` rule refusing the name sees `printf -v 'AWS_KEY[0]'`
    as a write to AWS_KEY. The refusal is raised, not collapsed into a
    status, so the rule's own words reach the user as they do from
    ``export``.

    Args:
        session (Session): shell session whose variables are written.
        view (SessionView | None): the session plane's door, which the
            write clears; None outside a workspace.
        name (str): the target's base variable name.
        subscript (str | None): the ``[...]`` text, or None for a scalar.
        value (str): the formatted text to store.

    Returns:
        str: ``"ok"``, ``"denied"``, ``"readonly"``, or ``"subscript"``.

    Raises:
        PolicyDenied: a pre_session rule refused the write; the caller
            renders the rule's own message.
    """
    return await assign_element(session, view, name, subscript, value)


async def handle_printf(
    args: list[str],
    session: Session,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print formatted output, honoring GNU printf's format-reuse rules.

    Supports ``%s %c %b %q``, the integer conversions ``%d %i %o %u %x
    %X``, the float conversions ``%f %F %e %E %g %G %a %A``, and ``%%``,
    with ``- + 0 # (space)`` flags, numeric or ``*`` width/precision, and
    backslash escapes (including ``\\u``/``\\U``) interpreted once in the
    same scan. When arguments remain after one pass the format is reused
    until they are exhausted; a missing argument renders as the empty
    string / ``0``. Integers wrap at 64 bits; ``%a`` formats at IEEE
    double precision. The conversion engine itself lives in
    ``printf_format``.

    With ``-v NAME`` the formatted text is stored in the shell variable
    ``NAME`` (or the array element ``NAME[idx]``) instead of written to
    stdout, matching GNU printf. An unusable ``NAME`` is rejected before
    the format runs (status 2); a readonly name or an out-of-range
    subscript still reports the format's own errors first, then fails
    with status 1 and leaves the variable untouched.

    Args:
        args (list[str]): the format followed by its arguments, optionally
            preceded by ``-v NAME``.
        session (Session): shell session, for the ``-v`` assignment.
    """
    target: str | None = None
    parsed: re.Match[str] | None = None
    if len(args) >= 2 and args[0] == "-v":
        target = args[1]
        args = args[2:]
        parsed = _PRINTF_TARGET_RE.match(target)
        if parsed is None:
            # bash validates the name before formatting, so a bad name
            # suppresses the conversion errors the format would report.
            err = f"printf: `{target}': not a valid identifier\n".encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="printf",
                                                             exit_code=2,
                                                             stderr=err)
    if not args:
        if target is not None:
            # `printf -v x` with no format is a usage error in bash.
            err = b"printf: usage: printf [-v var] format [arguments]\n"
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="printf",
                                                             exit_code=2)
        return b"", IOResult(), ExecutionNode(command="printf", exit_code=0)
    output, errors = run_printf(args[0], args[1:])
    err_bytes = "".join(errors).encode() if errors else b""
    if target is not None and parsed is not None:
        base, subscript = parsed.group(1), parsed.group(2)
        try:
            status = await _assign_printf_target(session, view, base,
                                                 subscript, output)
        except PolicyDenied as exc:
            err_bytes += f"bash: {exc.strerror}\n".encode()
            return None, IOResult(
                exit_code=1, stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
        except ArithError as exc:
            # The target carries `-i` and the formatted text does not
            # evaluate; bash voices the evaluator after the text.
            err_bytes += f"bash: printf: {exc}\n".encode()
            return None, IOResult(
                exit_code=1, stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
        if status != "ok":
            if status == "readonly":
                refusal = f"bash: {base}: readonly variable\n"
            elif status == "denied":
                refusal = f"bash: {base}: permission denied\n"
            else:
                refusal = f"bash: {target}: bad array subscript\n"
            err_bytes += refusal.encode()
            return None, IOResult(
                exit_code=1, stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
        exit_code = 1 if errors else 0
        return None, IOResult(exit_code=exit_code, stderr=err_bytes
                              or None), ExecutionNode(command="printf",
                                                      exit_code=exit_code)
    out = encode_text(output)
    if errors:
        return out, IOResult(exit_code=1,
                             stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
    return out, IOResult(), ExecutionNode(command="printf", exit_code=0)
