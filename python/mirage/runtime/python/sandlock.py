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
import os
import shutil
import sys
import sysconfig
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Callable, ClassVar

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.bootstrap import bootstrap
from mirage.runtime.python.flags import init_argv
from mirage.runtime.types import RunArgs, RunResult, RuntimeReach, ScriptSource

SANDLOCK_HOME_ENV = "MIRAGE_SANDLOCK_HOME"

SANDLOCK_CLI_HINT = (
    "the sandlock runtime needs the sandlock CLI on PATH "
    "(https://github.com/multikernel/sandlock); Linux only, and the full "
    "ruleset wants Landlock ABI v6 (Linux 6.12+)")

# What a host CPython needs to open before it can execute anything.
# Granted read-only and separately from the interpreter's own tree, so
# a config that lists no paths still boots instead of dying in the
# dynamic loader with no explanation.
SYSTEM_READABLE: tuple[str, ...] = ("/usr", "/lib", "/lib64", "/bin", "/etc",
                                    "/proc", "/dev")


@dataclass(frozen=True, slots=True, kw_only=True)
class SandlockConfig(RuntimeConfig):
    """What the confined interpreter may reach, and which one runs.

    Args:
        home (str | None): interpreter path or command name. None
            reads MIRAGE_SANDLOCK_HOME, then falls back to the
            interpreter running mirage.
        fs_readable (tuple[str, ...]): extra paths the code may read,
            on top of the interpreter's own tree and the system paths
            CPython needs to start.
        fs_writable (tuple[str, ...]): paths the code may write. A
            mirage FUSE mountpoint listed here is how confined code
            works on workspace files.
        max_memory (str | None): sandlock's memory cap for the run
            (its own spelling, e.g. "512M"). None leaves it uncapped.
        env (dict[str, str]): environment set for the run. Nothing is
            inherited from the mirage process, so anything the code
            needs must be named here.
    """

    home: str | None = None
    fs_readable: tuple[str, ...] = ()
    fs_writable: tuple[str, ...] = ()
    max_memory: str | None = None
    env: dict[str, str] = field(default_factory=dict)


def interpreter_readable(python: str) -> tuple[str, ...]:
    """The interpreter's own tree, which it must read to run at all.

    Always grants the prefix the binary sits in (`<venv>/bin/python`
    -> `<venv>`). The `sys`/`sysconfig` paths describe the interpreter
    running mirage, so they are granted only when that is also the
    interpreter about to run: adding them for a configured `home`
    would both miss that interpreter's real stdlib and hand confined
    code a read grant on mirage's own environment.

    A configured `home` whose stdlib lives outside its prefix (a
    distro-split or relocated build) needs that path listed in
    `fs_readable`; the interpreter fails loud in the dynamic loader
    rather than silently, so the omission is visible.

    Args:
        python (str): the resolved interpreter path.
    """
    paths = {os.path.dirname(os.path.dirname(python))}
    if python == sys.executable:
        paths |= {
            sys.prefix,
            sys.base_prefix,
            sysconfig.get_path("stdlib"),
            sysconfig.get_path("purelib"),
        }
    return tuple(sorted(path for path in paths if path))


class SandlockRuntime(PythonRuntime):
    """Run Python code on a host interpreter confined by sandlock.

    The same real CPython `local` spawns — full stdlib, native wheels,
    exact `sys.flags` — but wrapped in a Landlock ruleset and a seccomp
    filter, so the code reaches only the paths the config grants. Each
    run spawns `sandlock run -r ... -w ... -- <interpreter> -c <code>`;
    the sandlock CLI is the transport, so there is no SDK dependency,
    and cancelling the run kills the child exactly as it does for the
    host interpreter.

    Reach is "process", not "vfs", and the distinction is the point:
    confinement narrows WHICH host paths the code can touch, but the
    workspace gate still never sees the I/O, so mount modes, policy,
    and accounting do not apply to it. What it buys is that a
    "process" runtime need no longer be an unbounded one — grant it a
    mirage FUSE mountpoint through `fs_writable` and the code works on
    workspace files while reaching nothing else on the host.

    The environment is NOT inherited from the mirage process. `local`
    passes os.environ straight through, which is honest for an
    explicit host escape hatch but would hand every live backend
    credential to confined code; here only the config env and the run
    env are set.

    Linux only; sandlock's own degrade options cover kernels below the
    Landlock ABI v6 its full ruleset wants.
    """

    name = "sandlock"
    # A real host process, so the workspace gate never sees its I/O
    # even though Landlock bounds where that I/O can land.
    reach: RuntimeReach = "process"

    config_cls: ClassVar[type[RuntimeConfig]] = SandlockConfig
    config: SandlockConfig

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: SandlockConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        super().__init__(captures, config, script)
        chosen = self.config.home or os.environ.get(SANDLOCK_HOME_ENV)
        if chosen:
            resolved = shutil.which(chosen)
            if resolved is None:
                raise FileNotFoundError(
                    f"sandlock python interpreter not found: {chosen!r} "
                    "(from the runtime entry's config `home` or "
                    f"{SANDLOCK_HOME_ENV})")
            self._python = resolved
        else:
            self._python = sys.executable
        # Resolved once, on the mirage process's PATH: the child gets
        # an explicit environment carrying no PATH of its own, so a
        # bare name would not resolve at exec time.
        cli = shutil.which("sandlock")
        if cli is None:
            raise FileNotFoundError(SANDLOCK_CLI_HINT)
        self._sandlock = cli

    def policy_argv(self) -> list[str]:
        """The confinement flags for one run, from the config."""
        argv: list[str] = []
        readable = (*interpreter_readable(self._python), *SYSTEM_READABLE,
                    *self.config.fs_readable)
        for path in readable:
            argv += ["-r", path]
        for path in self.config.fs_writable:
            argv += ["-w", path]
        if self.config.max_memory is not None:
            argv += ["-m", self.config.max_memory]
        return argv

    async def run(self, args: RunArgs) -> RunResult:
        proc = await asyncio.create_subprocess_exec(
            self._sandlock,
            "run",
            *self.policy_argv(),
            "--",
            self._python,
            *init_argv(args.flags),
            "-c",
            bootstrap(args.code, args.prog),
            *args.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={
                **self.config.env,
                **args.env
            },
        )
        try:
            stdout, stderr = await proc.communicate(input=args.stdin)
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        return RunResult(
            stdout=stdout,
            stderr=stderr or None,
            exit_code=proc.returncode if proc.returncode is not None else 1,
        )
