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

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.workspace.executor.builtins.exec.constants import CLOSED
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.create import create_file
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


async def handle_exec_command(
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """The `exec` builtin without redirects.

    Bare `exec` is a no-op that succeeds. `exec CMD ...` asks the shell
    to replace itself with a program, which has no referent here (the
    in-process shell is an async executor, not an OS process: no PID,
    no `execve`), so it is refused loudly rather than run-then-exit,
    which would look like success while meaning something else. The
    redirect-only form (`exec > file`) never reaches here: it is a
    redirected statement, handled where redirects are applied.

    Args:
        args (list[str]): the words after `exec`.
        session (Session): shell session state.
    """
    if not args:
        return None, IOResult(), ExecutionNode(command="exec", exit_code=0)
    err = (f"mirage: exec: {args[0]}: process replacement is not supported "
           "(no OS process to replace)\n").encode()
    return None, IOResult(exit_code=2,
                          stderr=err), ExecutionNode(command="exec",
                                                     exit_code=2,
                                                     stderr=err)


async def install_exec_redirects(
    dispatch: DispatchFn,
    session: Session,
    redirects: list[Redirect],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Point the shell's own streams at files for the rest of the shell.

    The redirect-only `exec` form: `exec > file` sends every later
    statement's stdout to `file`, `exec 2> file` its stderr, `exec <
    file` feeds its stdin, and `exec >> file` appends. `2>&1` and `>&2`
    copy one stream's current target onto the other, and `>&-` / `<&-`
    close one. The output file is opened (created, and truncated unless
    appending) now, as bash opens it at `exec` time, so `exec > f`
    leaves an empty `f` even if nothing is written afterwards. A target
    that cannot be opened is bash's shell-attributed error and leaves
    the redirects unchanged.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        redirects (list[Redirect]): the expanded redirects.
    """
    for r in redirects:
        if r.kind == RedirectKind.STDIN:
            scope = _to_scope(r.target) if isinstance(r.target,
                                                      str) else r.target
            if isinstance(r.target, int):
                session.exec_stdin = None
                continue
            try:
                data, _ = await dispatch("read", scope)
            except FS_ERRORS as exc:
                return _exec_error(scope.raw_path, exc)
            session.exec_stdin = await materialize(data) or b""
            continue
        if r.kind == RedirectKind.STDERR_TO_STDOUT and isinstance(
                r.target, int):
            session.exec_stderr = session.exec_stdout
            session.exec_stderr_append = session.exec_stdout_append
            continue
        if r.fd == 1 and isinstance(r.target, int) and r.target == 2:
            session.exec_stdout = session.exec_stderr
            session.exec_stdout_append = session.exec_stderr_append
            continue
        if isinstance(r.target, int) and r.target == -1:
            # `>&-` / `<&-`: close the descriptor.
            if r.kind == RedirectKind.STDERR:
                session.exec_stderr = CLOSED
            elif r.kind == RedirectKind.STDIN:
                session.exec_stdin = b""
            else:
                session.exec_stdout = CLOSED
            continue
        if isinstance(r.target, int):
            continue
        scope = _to_scope(r.target) if isinstance(r.target, str) else r.target
        path = scope.virtual
        try:
            if await _open_target(dispatch, session, scope, r.append):
                session._exec_opened.add(path)
        except FS_ERRORS as exc:
            return _exec_error(scope.raw_path, exc)
        streams = ((["stderr"] if r.kind == RedirectKind.STDERR else
                    ["stdout"]) if r.fd != -1 else ["stdout", "stderr"])
        for stream in streams:
            setattr(session, f"exec_{stream}", path)
            setattr(session, f"exec_{stream}_append", r.append)
    return None, IOResult(), ExecutionNode(command="exec", exit_code=0)


async def _open_target(dispatch: DispatchFn, session: Session, scope: PathSpec,
                       append: bool) -> bool:
    """Open an `exec` redirect target, the way bash does at `exec` time.

    Truncating creates the file empty; appending creates it only when it
    is not already there, so an existing one keeps its bytes. Either way
    the file exists before the next statement runs, which is what makes
    `exec >> new; test -e new` succeed with nothing written. Returns
    whether it was written, which is what marks the target opened.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): the session holding the umask.
        scope (PathSpec): the target.
        append (bool): whether the redirect is `>>`.
    """
    if append:
        try:
            await dispatch("stat", scope)
            return False
        except FS_ERRORS as exc:
            logger.debug("exec append target %s is new: %s", scope.raw_path,
                         exc)
    await create_file(dispatch, session, scope, b"")
    return True


def _exec_error(label: str,
                exc: OSError) -> tuple[None, IOResult, ExecutionNode]:
    strerror = fs_strerror(exc)
    err = (f"{label}: {strerror}\n" if strerror else f"{label}\n").encode()
    return None, IOResult(exit_code=1,
                          stderr=err), ExecutionNode(command="exec",
                                                     exit_code=1,
                                                     stderr=err)


async def divert_statement(
    dispatch: DispatchFn,
    session: Session,
    stdout: bytes | None,
    io: IOResult,
) -> bytes | None:
    """Send one statement's output to the shell's `exec` targets.

    Called after each top-level statement when an `exec` redirect is in
    force: stdout and stderr that point at a file are appended to it
    (the first write to each target having truncated it at `exec`
    time), and the stream is cleared so it does not also reach the
    terminal. A closed stream is dropped. Returns the stdout that
    should still bubble up, which is None once it has been diverted.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        stdout (bytes | None): the statement's materialized stdout.
        io (IOResult): the statement's result; its stderr is diverted
            in place.
    """
    if session.exec_stdout is not None and stdout:
        await _append(dispatch, session, session.exec_stdout, stdout)
        stdout = None
    elif session.exec_stdout is not None:
        stdout = None
    if session.exec_stderr is not None and io.stderr is not None:
        data = await materialize(io.stderr) or b""
        if data:
            await _append(dispatch, session, session.exec_stderr, data)
        io.stderr = None
    return stdout


async def _append(dispatch: DispatchFn, session: Session, target: str,
                  data: bytes) -> None:
    """Append bytes to an `exec` target, or drop them if it is closed.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        target (str): the target path, or `""` for a closed stream.
        data (bytes): the bytes to write.
    """
    if target == CLOSED:
        return
    scope = _to_scope(target)
    # The target exists by now, since `exec` opened it: every write is
    # read-then-append. A file deleted since then reads empty rather
    # than failing, which is where the debug line below comes from.
    existing = b""
    try:
        prior, _ = await dispatch("read", scope)
        existing = await materialize(prior) or b""
    except FS_ERRORS as exc:
        logger.debug("exec append pre-read failed for %s: %s", target, exc)
    try:
        await dispatch("write", scope, data=existing + data)
        session._exec_opened.add(target)
    except FS_ERRORS as exc:
        logger.debug("exec write failed for %s: %s", target, exc)


async def exec_builtin(call: BuiltinCall) -> Result:
    """The ``exec`` arm.

    The redirect-only form is intercepted where redirects are applied;
    a bare ``exec`` reaching here has no redirects, and ``exec cmd`` is
    the process-replacement form this refuses.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_exec_command(list(call.argv.args), call.session)
