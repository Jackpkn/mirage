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

import asyncio
import shutil
import sys

import pytest

from mirage.runtime.python.sandlock import (SandlockRuntime,
                                            interpreter_readable)
from mirage.runtime.types import RunArgs

SANDLOCK_BIN = "/usr/bin/sandlock"


class FakeProcess:

    def __init__(self, stdout: bytes, stderr: bytes, code: int) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = code
        self.stdin_bytes: bytes | None = None
        self.killed = False

    async def communicate(self, input=None):
        self.stdin_bytes = input
        return self.stdout, self.stderr

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        return self.returncode


@pytest.fixture
def cli(monkeypatch):
    """Resolve `sandlock` and any interpreter on a host without them."""
    monkeypatch.setattr(
        shutil, "which", lambda name: SANDLOCK_BIN
        if name == "sandlock" else f"/usr/bin/{name}")


@pytest.fixture
def spawned(monkeypatch):
    """Capture the argv and env of the one spawn a run performs."""
    calls: list[dict] = []

    async def fake_exec(*argv, **kwargs):
        calls.append({"argv": list(argv), "env": kwargs.get("env")})
        return FakeProcess(b"out", b"", 0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


def test_it_is_a_confined_host_process_not_a_bridged_one():
    # "vfs" would claim the workspace gate sees its I/O; Landlock only
    # bounds where that I/O lands.
    assert SandlockRuntime.reach == "process"
    assert SandlockRuntime.captures == ("python3", "python")
    assert SandlockRuntime.runs_modules is True


def test_missing_cli_fails_loud_with_an_install_hint(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(FileNotFoundError, match="sandlock CLI on PATH"):
        SandlockRuntime()


def test_a_configured_home_that_does_not_exist_fails_loud(monkeypatch):
    monkeypatch.setattr(
        shutil, "which", lambda name: SANDLOCK_BIN
        if name == "sandlock" else None)
    with pytest.raises(FileNotFoundError, match="interpreter not found"):
        SandlockRuntime(config={"home": "python3.99"})


def test_policy_argv_grants_reads_writes_and_a_memory_cap(cli):
    runtime = SandlockRuntime(
        config={
            "fs_readable": ("/data", ),
            "fs_writable": ("/mnt/ws", "/tmp"),
            "max_memory": "512M",
        })
    argv = runtime.policy_argv()
    # Reads come first (the interpreter's tree, the system paths, then
    # the config's), writes next, the cap last.
    assert argv[-8:] == [
        "-r", "/data", "-w", "/mnt/ws", "-w", "/tmp", "-m", "512M"
    ]


def test_policy_argv_omits_the_cap_when_unset(cli):
    runtime = SandlockRuntime()
    assert "-m" not in runtime.policy_argv()


def test_the_interpreter_can_always_read_its_own_tree(cli):
    runtime = SandlockRuntime()
    argv = runtime.policy_argv()
    assert sys.prefix in argv
    # Without these CPython dies in the dynamic loader, so a config
    # granting nothing still has to boot.
    assert "/usr" in argv
    assert "/lib" in argv


def test_interpreter_readable_skips_sysconfig_for_another_interpreter():
    # Those paths describe the interpreter running mirage; granting
    # them for a configured home would both miss that interpreter's
    # real stdlib and expose mirage's own environment.
    paths = interpreter_readable("/opt/other/bin/python3")
    assert paths == ("/opt/other", )
    assert sys.prefix in interpreter_readable(sys.executable)


@pytest.mark.asyncio
async def test_run_wraps_the_interpreter_in_the_sandlock_cli(cli, spawned):
    runtime = SandlockRuntime(config={"fs_writable": ("/mnt/ws", )})
    result = await runtime.run(RunArgs(code="print(1)"))
    assert result.stdout == b"out"
    assert result.exit_code == 0
    argv = spawned[0]["argv"]
    assert argv[0] == SANDLOCK_BIN
    assert argv[1] == "run"
    separator = argv.index("--")
    assert ["-w", "/mnt/ws"] == argv[separator - 2:separator]
    assert argv[separator + 1] == sys.executable
    assert "-c" in argv[separator:]


@pytest.mark.asyncio
async def test_run_does_not_hand_the_mirage_environment_to_confined_code(
        cli, spawned, monkeypatch):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "leak-me")
    runtime = SandlockRuntime(config={"env": {"TZ": "UTC"}})
    await runtime.run(RunArgs(code="pass", env={"E": "1"}))
    assert spawned[0]["env"] == {"TZ": "UTC", "E": "1"}


@pytest.mark.asyncio
async def test_run_feeds_stdin_through(cli, spawned, monkeypatch):
    processes: list[FakeProcess] = []

    async def fake_exec(*argv, **kwargs):
        process = FakeProcess(b"", b"", 0)
        processes.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    runtime = SandlockRuntime()
    await runtime.run(RunArgs(code="pass", stdin=b"a\nb\n"))
    assert processes[0].stdin_bytes == b"a\nb\n"


@pytest.mark.asyncio
async def test_cancelling_a_run_reclaims_the_child(cli, monkeypatch):
    process = FakeProcess(b"", b"", 0)

    async def never_finishes(input=None):
        raise asyncio.CancelledError

    process.communicate = never_finishes

    async def fake_exec(*argv, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    runtime = SandlockRuntime()
    with pytest.raises(asyncio.CancelledError):
        await runtime.run(RunArgs(code="pass"))
    assert process.killed is True
