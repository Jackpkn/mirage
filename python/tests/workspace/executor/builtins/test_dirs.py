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

import pytest

from mirage.types import FileStat, FileType
from mirage.workspace.executor.builtins.dirs import handle_cd
from mirage.workspace.session import Session


def dispatcher(dirs=(), files=()):
    seen = []

    async def dispatch(_op, scope):
        seen.append(scope.virtual)
        if scope.virtual in dirs:
            return FileStat(name=scope.virtual, type=FileType.DIRECTORY), None
        if scope.virtual in files:
            return FileStat(name=scope.virtual, type=FileType.TEXT), None
        raise FileNotFoundError(scope.virtual)

    return dispatch, seen


def no_mount_root(_path: str) -> bool:
    return False


def session(cwd="/", **env) -> Session:
    return Session(session_id="test", cwd=cwd, env=dict(env))


@pytest.mark.asyncio
async def test_cd_moves_the_session_and_records_the_previous_directory():
    dispatch, _ = dispatcher(dirs={"/data/sub"})
    sess = session(cwd="/data")
    stdout, io, node = await handle_cd(dispatch, no_mount_root, "sub", sess)
    assert io.exit_code == 0
    assert stdout is None
    assert sess.cwd == "/data/sub"
    assert sess.env["OLDPWD"] == "/data"
    assert node.command == "cd sub"


@pytest.mark.asyncio
async def test_cd_to_root_never_consults_the_backend():
    dispatch, seen = dispatcher()
    sess = session(cwd="/data")
    _, io, _ = await handle_cd(dispatch, no_mount_root, "/", sess)
    assert io.exit_code == 0
    assert sess.cwd == "/"
    assert seen == []


@pytest.mark.asyncio
async def test_cd_prints_the_destination_when_asked():
    dispatch, _ = dispatcher(dirs={"/data"})
    stdout, io, _ = await handle_cd(dispatch,
                                    no_mount_root,
                                    "/data",
                                    session(),
                                    print_path=True)
    assert io.exit_code == 0
    assert stdout == b"/data\n"


@pytest.mark.asyncio
async def test_cd_refuses_a_missing_directory_and_leaves_the_cwd_alone():
    dispatch, _ = dispatcher()
    sess = session(cwd="/data")
    _, io, node = await handle_cd(dispatch, no_mount_root, "nope", sess)
    assert io.exit_code == 1
    assert io.stderr == b"cd: nope: No such file or directory\n"
    assert node.exit_code == 1
    assert sess.cwd == "/data"


@pytest.mark.asyncio
async def test_cd_refuses_a_regular_file():
    dispatch, _ = dispatcher(files={"/data/f.txt"})
    sess = session(cwd="/data")
    _, io, _ = await handle_cd(dispatch, no_mount_root, "f.txt", sess)
    assert io.exit_code == 1
    assert io.stderr == b"cd: f.txt: Not a directory\n"
    assert sess.cwd == "/data"


@pytest.mark.asyncio
async def test_cd_accepts_a_mount_root_the_backend_cannot_stat():
    dispatch, _ = dispatcher()
    sess = session()
    _, io, _ = await handle_cd(dispatch, lambda p: p == "/data", "/data", sess)
    assert io.exit_code == 0
    assert sess.cwd == "/data"


@pytest.mark.asyncio
async def test_cd_searches_cdpath_before_the_cwd_relative_candidate():
    dispatch, seen = dispatcher(dirs={"/opt/sub"})
    sess = session(cwd="/data", CDPATH="/opt")
    stdout, io, _ = await handle_cd(dispatch,
                                    no_mount_root,
                                    "sub",
                                    sess,
                                    cdpath_target="sub")
    assert io.exit_code == 0
    assert sess.cwd == "/opt/sub"
    assert seen == ["/opt/sub"]
    assert stdout == b"/opt/sub\n"


@pytest.mark.asyncio
async def test_cd_falls_back_to_the_cwd_when_no_cdpath_entry_matches():
    dispatch, seen = dispatcher(dirs={"/data/sub"})
    sess = session(cwd="/data", CDPATH="/opt")
    stdout, io, _ = await handle_cd(dispatch,
                                    no_mount_root,
                                    "sub",
                                    sess,
                                    cdpath_target="sub")
    assert io.exit_code == 0
    assert sess.cwd == "/data/sub"
    assert seen == ["/opt/sub", "/data/sub"]
    assert stdout is None


@pytest.mark.asyncio
async def test_cd_skips_the_cdpath_search_for_an_explicitly_relative_operand():
    dispatch, seen = dispatcher(dirs={"/data/sub"})
    sess = session(cwd="/data", CDPATH="/opt")
    _, io, _ = await handle_cd(dispatch,
                               no_mount_root,
                               "./sub",
                               sess,
                               cdpath_target="./sub")
    assert io.exit_code == 0
    assert seen == ["/data/sub"]


@pytest.mark.asyncio
async def test_cd_follows_a_symlink_to_its_target():
    dispatch, _ = dispatcher(dirs={"/real"})
    sess = session()
    _, io, _ = await handle_cd(dispatch,
                               no_mount_root,
                               "/link",
                               sess,
                               links={"/link": "/real"})
    assert io.exit_code == 0
    assert sess.cwd == "/real"


@pytest.mark.asyncio
async def test_cd_follows_a_symlink_that_is_only_a_prefix_of_the_operand():
    dispatch, _ = dispatcher(dirs={"/real/sub"})
    sess = session()
    _, io, _ = await handle_cd(dispatch,
                               no_mount_root,
                               "/link/sub",
                               sess,
                               links={"/link": "/real"})
    assert io.exit_code == 0
    assert sess.cwd == "/real/sub"


@pytest.mark.asyncio
async def test_cd_follows_a_chain_of_symlinks_to_the_final_target():
    dispatch, _ = dispatcher(dirs={"/real"})
    sess = session()
    _, io, _ = await handle_cd(dispatch,
                               no_mount_root,
                               "/a",
                               sess,
                               links={
                                   "/a": "/b",
                                   "/b": "/real"
                               })
    assert io.exit_code == 0
    assert sess.cwd == "/real"


@pytest.mark.asyncio
async def test_cd_reports_eloop_on_a_symlink_cycle():
    dispatch, _ = dispatcher()
    sess = session(cwd="/data")
    _, io, _ = await handle_cd(dispatch,
                               no_mount_root,
                               "/a",
                               sess,
                               links={
                                   "/a": "/b",
                                   "/b": "/a"
                               })
    assert io.exit_code == 1
    assert io.stderr == b"cd: /a: Too many levels of symbolic links\n"
    assert sess.cwd == "/data"
