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

import logging
from enum import Enum, auto

import tree_sitter

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.workspace.executor.builtins import _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


class _Fd(Enum):
    """Where a descriptor points when no file redirect has claimed it.

    An enum, not a sentinel object: the same variable also holds a
    virtual path string once a redirect lands, and a member can never
    collide with one.
    """
    TO_STDOUT = auto()
    TO_STDERR = auto()


_TO_STDOUT = _Fd.TO_STDOUT
_TO_STDERR = _Fd.TO_STDERR


async def handle_redirect(
    execute_node,
    dispatch,
    command: tree_sitter.Node | None,
    redirects: list[Redirect],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle all redirect patterns: >, >>, <, 2>, 2>&1, &>, >&2, <<<.

    File-descriptor routing follows bash's left-to-right fd table:
    each redirect updates where fd1/fd2 point at that moment, so
    `cmd > f 2>&1` sends both streams to f while `cmd 2>&1 > f`
    sends stderr to the original stdout. Output files are created (and
    truncated unless appending) when the redirect is processed, even
    if the stream ends up empty — including the command-less
    `> file` form (command is None).

    A redirect target that cannot be opened is a shell error, not a
    command error — on both the ``<`` read and the ``>`` write side.
    bash reports it itself and never names the command, so both paths
    render ``<target>: <strerror>`` (see ``_redirect_error_line``) and
    the rest of the line keeps running. bash also stops processing
    redirects at the first failed open, so later targets are left
    alone: GNU 5.2.37 answers ``echo x > /nodir/f > /data/out`` with one
    message and no ``/data/out``, while earlier targets keep the empty
    file their open already created (``echo y > /data/out2 > /nodir/g``
    leaves ``/data/out2`` present and empty).

    Deliberate divergence from bash: when both streams route to the
    same destination they are concatenated stdout-then-stderr, not
    temporally interleaved (streams are materialized buffers).

    Deliberate divergence from bash: because output files are created
    in a second pass (after the command runs), an output redirect that
    precedes a failing ``<`` is not truncated — bash processes
    redirects strictly left to right, so ``> out < missing`` empties
    ``out`` before failing. ``< missing > out`` leaves ``out``
    uncreated on both, which is bash's behavior. For the same reason a
    command whose ``>`` target is unwritable has already run here,
    while bash fails at open time and never runs it; the write error
    and exit 1 are reported either way.
    """
    cmd_stdin = stdin
    for r in redirects:
        if r.kind == RedirectKind.STDIN:
            scope = _ensure_scope(r.target)
            try:
                file_data, _ = await dispatch("read", scope)
            except FS_ERRORS as exc:
                return _redirect_failure(scope, exc)
            cmd_stdin = file_data
        elif r.kind == RedirectKind.HEREDOC:
            cmd_stdin = encode_text(r.target) if isinstance(r.target,
                                                            str) else r.target
        elif r.kind == RedirectKind.HERESTRING:
            text = r.target
            if isinstance(text, str):
                if text.startswith('"') and text.endswith('"'):
                    text = text[1:-1]
                elif text.startswith("'") and text.endswith("'"):
                    text = text[1:-1]
                cmd_stdin = encode_text(text + "\n")
            else:
                cmd_stdin = text

    if command is None:
        stdout_data = b""
        stderr_data = b""
        io = IOResult(exit_code=0)
    else:
        stdout, io, _ = await execute_node(command, session, cmd_stdin,
                                           call_stack)
        barriered = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
        if isinstance(barriered, memoryview):
            barriered = bytes(barriered)
        stdout_data = await materialize(barriered) or b""
        stderr_data = await materialize(io.stderr) or b""

    fd1: _Fd | str = _TO_STDOUT
    fd2: _Fd | str = _TO_STDERR
    file_bufs: dict[str, bytearray] = {}
    file_scopes: dict[str, PathSpec] = {}
    # Targets the open refused, and the line each one answers with. The
    # buffer is still built and fd1/fd2 still point at the path, so the
    # command's output lands in a buffer nobody writes -- bash never runs
    # the command at all, and printing its stdout instead would be the
    # one difference an agent could see.
    refused: dict[str, bytes] = {}

    for r in redirects:
        if r.kind in (RedirectKind.STDIN, RedirectKind.HEREDOC,
                      RedirectKind.HERESTRING):
            continue

        # 2>&1 — fd2 follows wherever fd1 points right now
        if r.kind == RedirectKind.STDERR_TO_STDOUT and isinstance(
                r.target, int):
            fd2 = fd1
            continue

        # >&2 or 1>&2 — fd1 follows wherever fd2 points right now
        if r.fd == 1 and isinstance(r.target, int) and r.target == 2:
            fd1 = fd2
            continue

        # other numeric dups (3>&1, ...) are not simulated
        if isinstance(r.target, int):
            continue

        scope = _ensure_scope(r.target)
        path = scope.virtual
        file_scopes[path] = scope
        if r.append:
            if path not in file_bufs:
                file_bufs[path] = bytearray(await
                                            _read_existing(dispatch, scope))
        else:
            file_bufs[path] = bytearray()

        if r.fd == -1:  # &> / &>>
            fd1 = path
            fd2 = path
        elif r.kind == RedirectKind.STDERR:
            fd2 = path
        else:
            fd1 = path

        line = await _open_refusal(dispatch, session, r, scope)
        if line is not None:
            refused[path] = line
            # bash stops at the first redirect it cannot open, so the
            # targets after this one are never touched.
            break

    out_stdout = bytearray()
    out_stderr = bytearray()
    for data, dest in ((stdout_data, fd1), (stderr_data, fd2)):
        if dest is _TO_STDOUT:
            out_stdout += data
        elif dest is _TO_STDERR:
            out_stderr += data
        elif isinstance(dest, str):
            file_bufs[dest] += data

    for path, buf in file_bufs.items():
        if path in refused:
            out_stderr += refused[path]
            io.exit_code = 1
            break
        data = bytes(buf)
        scope = file_scopes[path]
        try:
            await dispatch("write", scope, data=data)
        except FS_ERRORS as exc:
            out_stderr += _redirect_error_line(scope, exc)
            io.exit_code = 1
            break
        io.writes[path] = data

    result_stdout = bytes(out_stdout)
    io.stderr = bytes(out_stderr) if out_stderr else None
    exec_node = ExecutionNode(command="redirect", exit_code=io.exit_code)
    return result_stdout if result_stdout else None, io, exec_node


def _redirect_error_line(scope: PathSpec, exc: OSError) -> bytes:
    """GNU stderr line for a redirect target that could not be opened.

    GNU bash 5.2.37 answers both ``cat < missing`` and
    ``echo x > /nosuchdir/f`` with
    ``bash: line 1: <target>: No such file or directory`` and exit 1: the
    error belongs to the shell, not the command, and the rest of the line
    keeps running (``;`` continues, ``&&`` short-circuits, ``||`` runs).

    Deliberate divergence from bash: the ``bash: line N:`` prefix is
    dropped, so the line is ``<target>: <strerror>``. This matches the
    house style already set by the other shell-attributed error,
    ``nosuchcmd: command not found`` (bash prints
    ``bash: line 1: nosuchcmd: command not found``) — ``bash:`` is bash's
    ``$0`` and mirage is not bash, and ``line N`` has no meaning for a
    one-line ``Workspace.execute`` call.

    The label is the target's own spelling, never the exception's message:
    backends raise write failures with prose in ``str(exc)`` (``parent
    directory does not exist: /nodir``), which used to reach the user as
    the path.

    Args:
        scope (PathSpec): The redirect target that could not be opened.
        exc (OSError): The filesystem error raised by the read or write.
    """
    label = scope.raw_path
    strerror = fs_strerror(exc)
    return (f"{label}: {strerror}\n" if strerror else f"{label}\n").encode()


def _redirect_failure(scope: PathSpec,
                      exc: OSError) -> tuple[None, IOResult, ExecutionNode]:
    """Shell-attributed IOResult for a ``<`` source that cannot be read.

    bash never runs the command and stops processing redirects at the
    first failure, so this replaces the whole result. Returning an
    IOResult rather than letting the error propagate is what keeps the
    rest of the line alive; it also stops the workspace-level ``OSError``
    handler from stamping the line's first word onto the message
    (``cd /data && cat < missing`` used to report ``cd:``).

    Args:
        scope (PathSpec): The redirect source that could not be read.
        exc (OSError): The filesystem error raised by the read.
    """
    io = IOResult(exit_code=1, stderr=_redirect_error_line(scope, exc))
    return None, io, ExecutionNode(command="redirect", exit_code=1)


async def _open_refusal(dispatch, session: Session, r: Redirect,
                        scope: PathSpec) -> bytes | None:
    """The line GNU answers with when this redirect cannot be opened, or
    None when the open is allowed.

    `set -C` refuses a truncating open onto anything that already exists
    -- an empty file counts, since the test is existence and not size --
    while `>>` is always allowed and `>|` overrides for that one
    redirect without clearing the option. A directory reached under the
    option is refused too, in GNU's own wording for that case rather
    than the noclobber one.

    The probe runs only when the option is on, so the ordinary redirect
    path costs no extra round trip. That leaves `> <a directory>` with
    the option off silently succeeding, which is a separate pre-existing
    gap: GNU answers `Is a directory` and exit 1 whichever operator
    asked, and closing it means a stat on every output redirect.

    The target is stat'd through the op dispatcher rather than a
    backend, so a redirect that lands on another mount is answered by
    the mount that owns it.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): the session holding the shell options.
        r (Redirect): the redirect being processed.
        scope (PathSpec): its resolved target.
    """
    if r.append or r.clobber or not session.shell_options.get("noclobber"):
        return None
    try:
        stat, _ = await dispatch("stat", scope)
    except FS_ERRORS as exc:
        logger.debug("redirect open probe found no target at %s: %s",
                     scope.raw_path, exc)
        return None
    if stat is None:
        return None
    if getattr(stat, "type", None) == FileType.DIRECTORY:
        return f"{scope.raw_path}: Is a directory\n".encode()
    if noclobber:
        return f"{scope.raw_path}: cannot overwrite existing file\n".encode()
    return None


async def _read_existing(dispatch, scope) -> bytes:
    try:
        existing, _ = await dispatch("read", scope)
        if isinstance(existing, bytes):
            return existing
    except FS_ERRORS as exc:
        # appending starts from empty when the target is missing or
        # unreadable; the write that follows reports the real failure as
        # a shell-attributed line. Narrower than FS_ERRORS would let a
        # PermissionError escape to the workspace-level OSError handler,
        # which kills the rest of the line and misattributes the message.
        logger.debug("append pre-read failed for %s: %s", scope.raw_path, exc)
    return b""


def _ensure_scope(target):
    if isinstance(target, PathSpec):
        return target
    if isinstance(target, str):
        return _to_scope(target)
    return _to_scope(str(target))
