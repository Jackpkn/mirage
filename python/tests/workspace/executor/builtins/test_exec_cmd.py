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
"""exec: the redirect-only form, and the refused process-replacement one.

``exec > file`` sends the shell's own output to a file for the rest of
the shell (and across later lines of the same session); ``exec cmd`` has
no OS-process referent and is refused loudly. Output is read back from a
second session, since the first has its own output diverted.
"""
import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _ws() -> Workspace:
    ws = Workspace({"data": RAMResource()}, mode=MountMode.WRITE)
    ws._session_mgr.create("reader")
    return ws


async def _file(ws: Workspace, path: str) -> str:
    io = await ws.execute(f"cat {path}", session_id="reader")
    return await io.stdout_str()


@pytest.mark.asyncio
async def test_stdout_redirect_and_persistence():
    ws = _ws()
    await ws.execute("exec > /data/f; echo a; echo b")
    assert await _file(ws, "/data/f") == "a\nb\n"
    # Persists to a later line of the same (default) session.
    await ws.execute("echo c")
    assert await _file(ws, "/data/f") == "a\nb\nc\n"
    await ws.close()


@pytest.mark.asyncio
async def test_append_keeps_existing():
    ws = _ws()
    await ws.execute("echo old > /data/f; exec >> /data/f; echo new")
    assert await _file(ws, "/data/f") == "old\nnew\n"
    await ws.close()


@pytest.mark.asyncio
async def test_stderr_redirect():
    ws = _ws()
    await ws.execute("exec 2> /data/e; echo out; echo err >&2")
    assert await _file(ws, "/data/e") == "err\n"
    await ws.close()


@pytest.mark.asyncio
async def test_stdin_redirect_feeds_read():
    ws = _ws()
    io = await ws.execute(
        "printf 'l1\\nl2\\n' > /data/in; exec < /data/in; read a; read b; "
        "echo $a-$b",
        session_id="reader")
    assert (await io.stdout_str()) == "l1-l2\n"
    await ws.close()


@pytest.mark.asyncio
async def test_bare_exec_is_a_noop():
    ws = _ws()
    io = await ws.execute("exec; echo ok", session_id="reader")
    assert (await io.stdout_str()) == "ok\n"
    assert io.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_exec_command_is_refused():
    ws = _ws()
    io = await ws.execute("exec echo hi; echo after", session_id="reader")
    assert io.exit_code == 0
    assert (await io.stdout_str()) == "after\n"
    assert b"process replacement is not supported" in (io.stderr or b"")
    await ws.close()


@pytest.mark.asyncio
async def test_missing_target_leaves_redirect_unchanged():
    ws = _ws()
    io = await ws.execute("exec > /nodir/f; echo after", session_id="reader")
    assert (await io.stdout_str()) == "after\n"
    await ws.close()


@pytest.mark.asyncio
async def test_append_creates_the_target_with_no_output():
    """bash opens an `exec >>` target as it processes the exec, so the
    file is there before any statement runs."""
    ws = _ws()
    io = await ws.execute("( exec >> /data/new; ); test -e /data/new",
                          session_id="reader")
    assert io.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_append_open_keeps_existing_bytes():
    ws = _ws()
    io = await ws.execute(
        "echo old > /data/keep; ( exec >> /data/keep; ); cat /data/keep",
        session_id="reader")
    assert (await io.stdout_str()) == "old\n"
    await ws.close()


@pytest.mark.asyncio
async def test_opened_targets_take_the_umask_mode():
    """The same rule a plain `>` redirect follows, since both open a
    file: 0666 masked by the session umask."""
    ws = _ws()
    io = await ws.execute(
        "umask 077; ( exec > /data/m; echo z ); ( exec >> /data/a; ); "
        "stat -c '%a %n' /data/m /data/a",
        session_id="reader")
    assert (await io.stdout_str()) == "600 /data/m\n600 /data/a\n"
    await ws.close()
