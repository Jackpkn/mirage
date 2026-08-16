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

import pytest

from mirage.resource import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.script import _shebang_words


@pytest.fixture()
def ws() -> Workspace:
    return Workspace(
        resources={
            "/": (RAMResource(), MountMode.WRITE),
            "/work/": (RAMResource(), MountMode.WRITE),
        })


def _run(ws: Workspace, line: str):
    return asyncio.run(ws.execute(line))


def test_slash_head_word_runs_the_file(ws):
    _run(ws, "printf 'echo ran\\n' > /work/run.sh")
    result = _run(ws, "/work/run.sh")
    assert result.exit_code == 0
    assert result.stdout == b"ran\n"


def test_relative_path_resolves_against_cwd(ws):
    _run(ws, "printf 'echo rel\\n' > /work/run.sh")
    result = _run(ws, "cd /work && ./run.sh")
    assert result.stdout == b"rel\n"


def test_script_gets_dollar_zero_and_positionals(ws):
    # A line-final positional hits a pre-existing expansion bug that
    # `sh FILE` shows identically, so the line ends on a literal and
    # this pins only what path execution adds.
    _run(ws, "printf 'echo $0:$1:end\\n' > /work/args.sh")
    result = _run(ws, "/work/args.sh a b")
    assert result.stdout == b"/work/args.sh:a:end\n"


def test_shebang_interpreter_options_apply(ws):
    _run(ws, "printf '#!/bin/bash -x\\necho traced\\n' > /work/t.sh")
    result = _run(ws, "/work/t.sh")
    assert result.stdout == b"traced\n"
    assert result.stderr == b"+ echo traced\n"


def test_missing_file_is_127(ws):
    result = _run(ws, "/work/nope.sh")
    assert result.exit_code == 127
    assert result.stderr == b"/work/nope.sh: No such file or directory\n"


def test_directory_is_126(ws):
    _run(ws, "mkdir -p /work/adir")
    result = _run(ws, "/work/adir")
    assert result.exit_code == 126
    assert result.stderr == b"/work/adir: Is a directory\n"


def test_unknown_interpreter_reports_command_not_found(ws):
    _run(ws, "printf '#!/usr/bin/env ruby\\nputs 1\\n' > /work/r.rb")
    result = _run(ws, "/work/r.rb")
    assert result.exit_code == 127
    assert result.stderr == b"ruby: command not found\n"


def test_child_shell_state_does_not_leak(ws):
    _run(ws, "printf 'cd /work\\nexit 3\\n' > /child.sh")
    result = _run(ws, "/child.sh; echo \"$?:$(pwd)\"")
    assert result.stdout == b"3:/\n"


def test_shebang_words_resolves_env_and_basenames():
    assert _shebang_words("#!/bin/sh\necho hi\n") == ["sh"]
    assert _shebang_words("#!/usr/bin/env bash\n") == ["bash"]
    assert _shebang_words("#!/bin/bash -x\n") == ["bash", "-x"]
    assert _shebang_words("#!/usr/bin/env python3\n") == ["python3"]
    assert _shebang_words("echo no shebang\n") == []
