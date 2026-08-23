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
import logging
import os

from mirage import MountMode, Workspace
from mirage.nfs.backend import check_platform_nfs
from mirage.resource.ram import RAMResource
from mirage.types import FileStat
from mirage.workspace.nfs import NFSManager


class SizelessOps:
    """Ops proxy that strips stat sizes.

    Simulates API-backed resources whose byte size is unknown until the
    content is fetched. NFSv3 has no OPEN procedure, so unlike FUSE
    there is no hydrate-on-open: the documented behavior is that such
    files stat as 0 and read as empty, with a mount-time warning.
    """

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def stat(self, path: str) -> FileStat:
        result = await self._inner.stat(path)
        return result.model_copy(update={"size": None})

    def unsized_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        # The size-unknown declaration the mount-time warning reads:
        # a real API resource carries SIZES_ALWAYS_KNOWN=False, and
        # this proxy is standing in for one.
        del root_prefix
        return [("/", "sizeless")]


async def sh(*argv: str) -> tuple[int, str]:
    """Run one command off-loop and capture its output.

    Every touch of the mountpoint must leave the event loop: the NFS
    server is served BY this loop, so a synchronous stat here would
    deadlock the request it produces.

    Args:
        argv (str): the command and its arguments.

    Returns:
        tuple[int, str]: exit code and combined output.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def write_file(path: str, text: str) -> int:
    code, _ = await sh("sh", "-c", f"printf '%s' '{text}' > {path}")
    return code


async def run_battery(result: dict[str, object]) -> None:
    """The single-server, multi-mount battery over a RAM workspace.

    Args:
        result (dict): probe results, keyed for truth_nfs.json.
    """
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo alpha > /a.txt")
    await ws.execute("mkdir /docs && echo beta > /docs/b.txt")

    manager = NFSManager()
    try:
        whole = await manager.setup(ws.ops, "/")
        docs = await manager.setup(ws.ops, "/docs")
        result["distinct_mounts"] = whole != docs

        _, out = await sh("cat", f"{whole}/a.txt")
        result["cat_a"] = out
        _, out = await sh("cat", f"{docs}/b.txt")
        result["subtree_cat_b"] = out
        _, out = await sh("ls", whole)
        result["ls_names"] = sorted(n for n in out.split() if n != "dev")

        result["write_ok"] = await write_file(f"{docs}/new.txt",
                                              "via-nfs") == 0
        _, out = await sh("cat", f"{whole}/docs/new.txt")
        result["cross_mount_readback"] = out

        code, _ = await sh("ln", "-s", "a.txt", f"{whole}/lnk")
        result["symlink_ok"] = code == 0
        _, out = await sh("readlink", f"{whole}/lnk")
        result["readlink"] = out
        _, out = await sh("cat", f"{whole}/lnk")
        result["cat_through_link"] = out
        await sh("rm", f"{whole}/lnk")
        _, out = await sh("cat", f"{whole}/a.txt")
        result["target_survives_link_rm"] = out

        code, _ = await sh(
            "sh", "-c", f"mkdir {whole}/d && "
            f"mv {whole}/docs/new.txt {whole}/d/m.txt")
        result["mkdir_mv_ok"] = code == 0

        try:
            await manager.setup(ws.ops, "/dev", whole)
            result["collision_rejected"] = False
        except ValueError:
            result["collision_rejected"] = True
    finally:
        await manager.close()

    io = await ws.execute("cat /d/m.txt")
    result["close_flushed"] = (await io.materialize_stdout()).decode().strip()
    result["mountpoints_cleaned"] = (not os.path.exists(whole)
                                     and not os.path.exists(docs))


async def run_sizeless(result: dict[str, object]) -> None:
    """Size-unknown files read as empty, and the mount warns.

    Args:
        result (dict): probe results.
    """
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo hidden-content > /api.json")

    records: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger("mirage.nfs.backend").addHandler(handler)

    manager = NFSManager()
    try:
        mnt = await manager.setup(SizelessOps(ws.ops), "/")
        _, out = await sh("cat", f"{mnt}/api.json")
        result["sizeless_reads_empty"] = out == ""
        code, out = await sh("stat", "-f", "%z", f"{mnt}/api.json")
        if code != 0:
            code, out = await sh("stat", "-c", "%s", f"{mnt}/api.json")
        result["sizeless_stat_zero"] = out == "0"
    finally:
        await manager.close()
        logging.getLogger("mirage.nfs.backend").removeHandler(handler)
    result["sizeless_warned"] = any("read as empty" in r.getMessage()
                                    for r in records)


async def main() -> None:
    result: dict[str, object] = {}
    try:
        check_platform_nfs("win32")
        result["win32_refused"] = False
    except RuntimeError:
        result["win32_refused"] = True

    await run_battery(result)
    await run_sizeless(result)
    print(json.dumps(result))


asyncio.run(main())
