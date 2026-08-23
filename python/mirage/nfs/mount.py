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
import sys
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.nfs.backend import prepare_nfs_mount
from mirage.nfs.config import NFSConfig
from mirage.nfs.fs import MirageNFS
from mirage.ops import Ops

MOUNT_TIMEOUT_SECONDS = 10.0
_POLL_SECONDS = 0.05


def load_wheel() -> Any:
    """Import the mirage-nfs extension, naming the extra when absent.

    The wheel is optional the way FUSE's driver is: importing mirage
    never requires it, and the error names the install command rather
    than leaking an ImportError from deep inside a mount call.
    """
    try:
        import mirage_nfs
    except ImportError as exc:
        raise RuntimeError(
            "the nfs mount backend needs the mirage-nfs extension; "
            "install it with: pip install mirage-ai[nfs]") from exc
    return mirage_nfs


def mount_args(mountpoint: str,
               port: int,
               export: str,
               platform: str | None = None) -> list[str]:
    """The kernel mount command for one export.

    ``port=mountport=<port>`` keeps portmap (111) and NLM out of the
    picture entirely; ``actimeo=0`` keeps client attribute caches
    fresh, the analogue of the FUSE mounts' ``attr_timeout=0``.

    Args:
        mountpoint (str): where to mount.
        port (int): the TCP port serving both MOUNT and NFS.
        export (str): export path, ``/`` or ``/<prefix>``.
        platform (str | None): platform tag, defaulting to the running
            one; a parameter so the argv is testable everywhere.

    Returns:
        list[str]: argv for the platform's mount command.
    """
    tag = sys.platform if platform is None else platform
    source = f"127.0.0.1:{export}"
    if tag == "darwin":
        opts = (f"nolocks,vers=3,tcp,rsize=131072,actimeo=0,"
                f"port={port},mountport={port}")
        return ["mount_nfs", "-o", opts, source, mountpoint]
    opts = (f"nolock,vers=3,tcp,rsize=131072,actimeo=0,"
            f"port={port},mountport={port}")
    return ["mount", "-t", "nfs", "-o", opts, source, mountpoint]


def umount_args(mountpoint: str, platform: str | None = None) -> list[str]:
    """The unmount command for a mountpoint.

    Plain ``umount`` everywhere first; the darwin caller falls back to
    ``diskutil unmount force`` when it refuses.

    Args:
        mountpoint (str): the mounted path.
        platform (str | None): platform tag, for tests.
    """
    del platform
    return ["umount", mountpoint]


def prepare_mountpoint(mountpoint: str | None) -> tuple[str, bool]:
    """Resolve the mountpoint, creating a temporary one when unnamed.

    Args:
        mountpoint (str | None): caller-owned path, or None for a
            fresh temp directory mirage owns and may delete.

    Returns:
        tuple[str, bool]: the path and whether mirage owns it.
    """
    if mountpoint:
        os.makedirs(mountpoint, exist_ok=True)
        return mountpoint, False
    return tempfile.mkdtemp(prefix="mirage-nfs-"), True


async def _ismount_off_loop(path: str) -> bool:
    """``os.path.ismount`` from a worker thread.

    The probe stats the mountpoint, and over NFS that stat is served by
    this very event loop -- run inline it would block the loop that has
    to answer it, which is the self-touch deadlock in miniature.

    Args:
        path (str): the mountpoint to probe.
    """
    return await asyncio.to_thread(os.path.ismount, path)


async def await_ismount(
    mountpoint: str,
    timeout: float = MOUNT_TIMEOUT_SECONDS,
    probe: Callable[[str], Awaitable[bool]] = _ismount_off_loop,
) -> None:
    """Wait until the kernel reports a live mount, or fail loudly.

    The FSKit lesson: a mountpoint directory existing is not a mount,
    so readiness is ``ismount``, never bare existence.

    Args:
        mountpoint (str): the path being mounted.
        timeout (float): seconds to wait before giving up.
        probe (Callable): mount check, injectable for tests.

    Raises:
        TimeoutError: the mount never came up.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await probe(mountpoint):
            return
        await asyncio.sleep(_POLL_SECONDS)
    raise TimeoutError(
        f"nfs mount at {mountpoint!r} did not come up within {timeout}s")


async def run_mount(mountpoint: str, port: int, export: str) -> None:
    """Run the kernel mount command and wait for the mount to be live.

    Args:
        mountpoint (str): where to mount.
        port (int): the server's TCP port.
        export (str): export path for the MOUNT protocol.

    Raises:
        RuntimeError: the mount command failed, with its output.
        TimeoutError: the command succeeded but no mount appeared.
    """
    argv = mount_args(mountpoint, port, export)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{argv[0]} failed ({proc.returncode}): "
                           f"{out.decode(errors='replace').strip()}")
    await await_ismount(mountpoint)


async def run_umount(mountpoint: str) -> None:
    """Unmount, falling back to diskutil force on a darwin refusal.

    Args:
        mountpoint (str): the mounted path.
    """
    proc = await asyncio.create_subprocess_exec(
        *umount_args(mountpoint),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL)
    await proc.wait()
    if proc.returncode != 0 and sys.platform == "darwin":
        fallback = await asyncio.create_subprocess_exec(
            "diskutil",
            "unmount",
            "force",
            mountpoint,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL)
        await fallback.wait()


async def start_server(ops: Ops, config: NFSConfig) -> tuple[MirageNFS, Any]:
    """Run the mount guards and start the NFS server for one op tree.

    Args:
        ops (Ops): the op facade to serve.
        config (NFSConfig): host, port and flush knobs.

    Returns:
        tuple[MirageNFS, Any]: the delegate and the server handle,
        whose ``port()`` reports the bound port.
    """
    prepare_nfs_mount("nfs", ops, config)
    wheel = load_wheel()
    fs = MirageNFS(ops, config)
    uid = os.getuid() if hasattr(os, "getuid") else 0
    gid = os.getgid() if hasattr(os, "getgid") else 0
    handle = wheel.start(fs,
                         asyncio.get_running_loop(), config.host, config.port,
                         fs.root_dir(), uid, gid, config.idle_flush_seconds)
    return fs, handle
