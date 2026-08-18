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

from typing import Any

from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_text
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.shell.types import NodeType as NT
from mirage.utils.errors import format_fs_error
from mirage.workspace.executor.builtins.exec import divert_statement
from mirage.workspace.executor.control import (BreakSignal, ContinueSignal,
                                               ReturnSignal)
from mirage.workspace.executor.jobs import handle_background
from mirage.workspace.types import ExecutionNode


async def execute_program(
    recurse,
    node,
    session,
    stdin,
    call_stack,
    job_table,
    agent_id,
    dispatch=None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute program node (root / semicolon-separated).

    ``dispatch`` is the op door, threaded so an active ``exec`` redirect
    can send each statement's output to its file; None (a nested loop
    that is not the program root) leaves output undiverted.
    """
    # Every program loop is one parse, which is the unit bash's alias
    # rule counts in: an alias defined on this parse and row is not
    # expanded by a use on the same parse and row. Restored on the way
    # out so a nested parse (`eval`, `source`, `bash -c`) does not leave
    # its id on the enclosing one.
    session._parse_seq += 1
    outer_parse = session._parse_current
    session._parse_current = session._parse_seq
    try:
        return await _run_program(recurse, node, session, stdin, call_stack,
                                  job_table, agent_id, dispatch)
    finally:
        session._parse_current = outer_parse


async def _run_program(
    recurse,
    node,
    session,
    stdin,
    call_stack,
    job_table,
    agent_id,
    dispatch=None,
) -> tuple[Any, IOResult, ExecutionNode]:
    children = node.children
    all_stdout: list[Any] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)
    # Source lines and the highest one `set -v` has already echoed.
    source_lines = get_text(node).split("\n")
    echoed_row = -1

    i = 0
    while i < len(children):
        child = children[i]

        if (not child.is_named or child.type == NT.ERROR
                or child.type == NT.COMMENT):
            if child.type == NT.SEMI:
                i += 1
                continue
            i += 1
            continue

        # `set -n` reads without executing, so every statement after the
        # one that set it is skipped. Checking here rather than deeper
        # gives bash's one-way trip for free: a later `set +n` is itself
        # a statement, so it never runs and cannot turn execution back
        # on within the same input.
        if session.shell_options.get("noexec"):
            break

        # `set -v` echoes input to stderr as the reader consumes it, and
        # the unit is a *line*, not a statement: GNU answers
        # `set -v; echo a` with nothing at all, because that whole line
        # was already read before the option took effect, while
        # `set -v\necho a` echoes the second line. So a line is echoed
        # once, when the first statement on it runs, and a statement
        # spanning several lines carries all of them.
        if child.start_point[0] > echoed_row:
            # From the line after the last one echoed, not from this
            # statement's own row: the reader consumes comments and
            # blank lines too, so `# note`, an empty line and `echo ok`
            # all reach stderr. Clamping to the next executable row
            # dropped everything that carried no node.
            first = echoed_row + 1
            last = child.end_point[0]
            if session.shell_options.get("verbose") and last >= first:
                text = "\n".join(source_lines[first:last + 1])
                merged_io = await merged_io.merge(
                    IOResult(stderr=text.encode() + b"\n"))
            # Marked read either way: a line reaches the reader once, so
            # a line whose own first statement turned the option on was
            # already past it and is never echoed.
            echoed_row = last

        # Check for background: named node followed by & token
        is_bg = (i + 1 < len(children)
                 and children[i + 1].type == NT.BACKGROUND)

        if is_bg:
            stdout, io, last_exec = await handle_background(
                recurse, child, None, session, job_table, agent_id, stdin,
                call_stack)
            # Launching a job is itself a statement: bash sets $? to 0
            # (the launch status), so `false; cmd & echo $?` prints 0.
            session.last_exit_code = io.exit_code
            i += 2
        else:
            child_stdin = stdin
            if child_stdin is None and session.exec_stdin is not None:
                # `exec < file` feeds the shell's stdin: a later `read`
                # or `while read` sees it. The same bytes reach each
                # statement, and the identity-keyed line buffer advances
                # a sequence of reads through it.
                child_stdin = session.exec_stdin
            try:
                stdout, io, last_exec = await recurse(child, session,
                                                      child_stdin, call_stack)
            except ExitSignal as sig:
                # exit (or a fatal expansion error) ends the line: keep
                # what earlier statements produced, drop the rest.
                if sig.stdout:
                    all_stdout.append(sig.stdout)
                sig_io = IOResult(exit_code=sig.exit_code,
                                  stderr=sig.stderr or None)
                merged_io = await merged_io.merge(sig_io)
                merged_io.exit_code = sig.exit_code
                session.last_exit_code = sig.exit_code
                last_exec = ExecutionNode(command="exit",
                                          exit_code=sig.exit_code,
                                          stderr=sig.stderr)
                break
            except ReturnSignal as sig:
                # `return` inside a sourced file ends the source; the
                # file's status becomes the return's. Anywhere else the
                # signal belongs to an enclosing function call.
                if session.source_depth <= 0:
                    raise
                if sig.stderr:
                    merged_io = await merged_io.merge(
                        IOResult(stderr=sig.stderr))
                merged_io.exit_code = sig.exit_code
                session.last_exit_code = sig.exit_code
                last_exec = ExecutionNode(command="return",
                                          exit_code=sig.exit_code)
                break
            except (BreakSignal, ContinueSignal) as sig:
                # break/continue with a level beyond the loop nesting
                # ends every enclosing loop and execution continues
                # with the next statement, like bash (which clamps the
                # level to the actual depth).
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                session.last_exit_code = sig.io.exit_code
                i += 1
                continue
            # Materialize stdout so lazy exit codes (e.g. from
            # exit_on_empty in grep) are finalized before $? is set.
            drain_err: bytes | None = None
            try:
                stdout = await materialize(stdout)
            except OSError as exc:
                # Lazy reads (head/tail opening the stream mid-pipeline) can
                # fail on the first pull; format as a GNU coreutils line,
                # respelling the path as typed via the operands the leaf
                # node carries, mirroring the eager executor chokepoint.
                cmd_name = (last_exec.command.split()[0]
                            if last_exec.command else "")
                drain_err = format_fs_error(cmd_name, exc, last_exec.paths)
                stdout = None
            except Exception as exc:
                drain_err = f"{exc}\n".encode()
                stdout = None
            if drain_err is not None:
                existing = await materialize(io.stderr) or b""
                io.stderr = existing + drain_err
                io.exit_code = 1
            session.last_exit_code = io.exit_code
            i += 1

        # An `exec` redirect sends the shell's own output to a file:
        # every statement after the `exec` diverts here, so nothing
        # bubbles to the terminal and stderr lands in its own target.
        if dispatch is not None and (session.exec_stdout is not None
                                     or session.exec_stderr is not None):
            materialized = await materialize(stdout)
            stdout = await divert_statement(dispatch, session, materialized,
                                            io)
        if stdout is not None:
            all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)

        if (io.exit_code != 0 and session.shell_options.get("errexit")
                and not is_bg and child.type not in ERREXIT_EXEMPT_TYPES
                and not session.errexit_immune):
            merged_io.exit_code = io.exit_code
            break

    if len(all_stdout) == 1:
        return all_stdout[0], merged_io, last_exec
    combined = async_chain(*all_stdout) if all_stdout else None
    return combined, merged_io, last_exec
