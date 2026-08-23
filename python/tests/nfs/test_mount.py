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
import sys

import pytest

from mirage.nfs.config import NFSConfig
from mirage.nfs.mount import (await_ismount, mount_args, prepare_mountpoint,
                              umount_args)


def test_mount_args_darwin_pins_port_and_export():
    argv = mount_args("/tmp/m", 20490, "/docs", platform="darwin")
    assert argv[0] == "mount_nfs"
    joined = " ".join(argv)
    assert "port=20490" in joined and "mountport=20490" in joined
    assert "actimeo=0" in joined
    assert argv[-2] == "127.0.0.1:/docs"
    assert argv[-1] == "/tmp/m"


def test_mount_args_linux_uses_mount_t_nfs():
    argv = mount_args("/tmp/m", 111, "/", platform="linux")
    assert argv[:3] == ["mount", "-t", "nfs"]
    assert "nolock" in " ".join(argv)
    assert argv[-2] == "127.0.0.1:/"


def test_umount_args_per_platform():
    assert umount_args("/tmp/m", platform="linux") == ["umount", "/tmp/m"]
    assert umount_args("/tmp/m", platform="darwin") == ["umount", "/tmp/m"]


def test_prepare_mountpoint_creates_and_owns_a_temp_dir(tmp_path):
    path, owns = prepare_mountpoint(None)
    assert owns is True
    import os
    assert os.path.isdir(path)
    os.rmdir(path)


def test_prepare_mountpoint_keeps_a_caller_path(tmp_path):
    target = str(tmp_path / "mnt")
    path, owns = prepare_mountpoint(target)
    assert path == target and owns is False
    import os
    assert os.path.isdir(target)


async def _always_false(path: str) -> bool:
    return False


async def _always_true(path: str) -> bool:
    return True


def test_await_ismount_times_out_with_a_clear_error():
    with pytest.raises(TimeoutError) as exc:
        asyncio.run(
            await_ismount("/tmp/never", timeout=0.05, probe=_always_false))
    assert "/tmp/never" in str(exc.value)


def test_await_ismount_returns_when_the_probe_passes():
    asyncio.run(await_ismount("/tmp/now", timeout=1.0, probe=_always_true))


def test_config_is_reused_for_defaults():
    assert NFSConfig().port == 20490
    assert sys.platform in ("darwin", "linux", "win32")
