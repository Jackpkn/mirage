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
import json

from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.smolvm.config import SmolvmConfig
from mirage.runtime.sandbox.smolvm.constants import (RUNNING_STATE,
                                                     SMOLVM_CLI_HINT,
                                                     not_running_hint)
from mirage.runtime.types import RunResult


class SmolvmRuntime(RemoteSandbox):
    """A microVM the user runs as a whole-line runtime.

    You start the machine yourself; mirage only connects to it and
    execs lines. The smolvm CLI is the transport, so there is no SDK
    dependency and no daemon socket wiring; each line is one `smolvm
    machine exec` with the merged environment, the rebased cwd, real
    stdin, and separated stderr.

    Unlike a container, the guest runs its own kernel, so the line
    sees that kernel's filesystem and nothing of the host's except
    what the machine was given at boot (`--volume`). Serve the
    workspace inside the guest at the host's mount prefixes, the same
    contract every provider in this family carries.

    Args:
        options (Any): the RemoteSandbox constructor fields.
    """

    name = "smolvm"
    config_cls = SmolvmConfig
    config: SmolvmConfig

    async def _smolvm(self,
                      args: list[str],
                      stdin: bytes | None = None) -> tuple[bytes, bytes, int]:
        """One smolvm CLI invocation; the seam tests override."""
        try:
            process = await asyncio.create_subprocess_exec(
                "smolvm",
                *args,
                stdin=(asyncio.subprocess.PIPE
                       if stdin is not None else asyncio.subprocess.DEVNULL),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise RuntimeError(SMOLVM_CLI_HINT) from None
        stdout, stderr = await process.communicate(stdin)
        return stdout, stderr, process.returncode or 0

    async def connect(self) -> None:
        """Probe the machine, refusing any state that cannot take a line.

        `machine exec` would start a stopped machine on its own, but
        this family never manages sandbox lifecycle, so a machine that
        is not already running is an error rather than a boot.
        """
        stdout, stderr, code = await self._smolvm(
            ["machine", "status", "--name", self.config.machine, "--json"])
        if code != 0:
            raise RuntimeError(
                f"smolvm machine status failed: {stderr.decode().strip()}")
        try:
            status = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("smolvm machine status returned unreadable "
                               f"json: {exc}") from exc
        state = status.get("state")
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint(self.config.machine, str(state)))

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        args = [
            "machine", "exec", "--name", self.config.machine, "-i", "-w", cwd
        ]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        # `--` ends the flags: the command is a trailing var arg, so a
        # line starting with a dash would otherwise parse as one.
        args += ["--", "sh", "-c", line]
        stdout, stderr, code = await self._smolvm(args, stdin=stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)
