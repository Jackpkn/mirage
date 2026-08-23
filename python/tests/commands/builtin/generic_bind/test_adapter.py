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

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.generic_bind.adapter import (CommandIO, Operation,
                                                          dir_aware_stat,
                                                          dir_aware_stream)
from mirage.commands.config import CommandOpts
from mirage.ops.types import NamespaceView
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES

TREE = {
    "/notion/pages": [
        "/notion/pages/Demo_page__uuid1",
        "/notion/pages/Roadmap__uuid2",
    ],
}


async def fake_readdir(accessor, path, index=None):
    key = path.virtual.rstrip("/") or "/"
    if key not in TREE:
        raise FileNotFoundError(key)
    return TREE[key]


def glob_spec(virtual: str, prefix: str) -> PathSpec:
    last_slash = virtual.rfind("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual[:last_slash + 1],
        resource_path=virtual[len(prefix):].strip("/"),
        pattern=virtual[last_slash + 1:],
        resolved=False,
    )


def make_io(**kwargs) -> CommandIO:
    return CommandIO(readdir=fake_readdir,
                     read_bytes=fake_readdir,
                     read_stream=fake_readdir,
                     stat=fake_readdir,
                     is_mounted=lambda a: True,
                     **kwargs)


def test_command_io_default_glob_cap():
    assert make_io().max_glob_matches == DEFAULT_MAX_GLOB_MATCHES


@pytest.mark.asyncio
async def test_command_io_resolve_glob_binds_readdir():
    resolve = make_io().resolve_glob
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_command_io_resolve_glob_honors_cap():
    resolve = make_io(max_glob_matches=1).resolve_glob
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert len(result) == 1


def test_command_io_require_missing_op():
    io = make_io()
    with pytest.raises(NotImplementedError):
        io.require(Operation.WRITE)
    assert make_io(write=fake_readdir).require(Operation.WRITE) is fake_readdir


def _probe_ops(missing: set[str],
               implicit_dirs: set[str] | None = None,
               explicit_dirs: set[str] | None = None) -> CommandIO:
    dirs = implicit_dirs or set()
    typed = explicit_dirs or set()

    async def stat(_accessor, path, _index):
        if path.virtual in missing or path.virtual in dirs:
            raise FileNotFoundError(path.virtual)
        if path.virtual in typed:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        return FileStat(type=FileType.FILE, name=path.virtual, size=0)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        entries = [d for d in dirs if (d.rsplit("/", 1)[0] or "/") == target]
        if path.virtual in dirs:
            entries.append(path.virtual.rstrip("/") + "/child.txt")
        return entries

    async def read_stream(_accessor, _path, _index):
        yield b"data"

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=read_stream,
                     stat=stat,
                     is_mounted=lambda _a: True)


# No namespace facts, which is what a command bound outside a workspace
# gets: only the two probes below the backend can fire.
NO_NS = CommandOpts()


def _ns_dir(directory: str) -> CommandOpts:
    """A bag whose namespace owes one path a child name and nothing else."""

    def child_mounts(parent: str) -> list[str]:
        return ["alpha"] if parent == directory else []

    return CommandOpts(ns=NamespaceView(child_mounts=child_mounts))


@pytest.mark.asyncio
async def test_dir_aware_stat_refuses_a_namespace_only_mount_parent():
    # No backend knows the path: its keys live in a mount nested under it,
    # so neither the stat nor the parent-listing probe can see it, and the
    # name plane is the only thing that can call it a directory.
    stat = dir_aware_stat(_probe_ops({"/ghost"}), None, _ns_dir("/ghost"))
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/ghost"))


@pytest.mark.asyncio
async def test_dir_aware_stat_keeps_enoent_when_the_namespace_agrees():
    stat = dir_aware_stat(_probe_ops({"/ghost"}), None, _ns_dir("/elsewhere"))
    with pytest.raises(FileNotFoundError):
        await stat(PathSpec.from_str_path("/ghost"))


@pytest.mark.asyncio
async def test_dir_aware_stream_refuses_a_namespace_only_mount_parent():
    read = dir_aware_stream(_probe_ops({"/ghost"}), None, _ns_dir("/ghost"))
    with pytest.raises(IsADirectoryError):
        async for _ in read(PathSpec.from_str_path("/ghost")):
            raise AssertionError("no data expected")


@pytest.mark.asyncio
async def test_dir_aware_stat_refines_implicit_dir_to_eisdir():
    stat = dir_aware_stat(_probe_ops(set(), implicit_dirs={"/sub"}), None,
                          NO_NS)
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_aware_stat_refuses_explicit_dirs():
    stat = dir_aware_stat(_probe_ops(set(), explicit_dirs={"/sub"}), None,
                          NO_NS)
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_aware_stat_keeps_enoent_for_missing_files():
    stat = dir_aware_stat(_probe_ops({"/nope.txt"}), None, NO_NS)
    with pytest.raises(FileNotFoundError):
        await stat(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stat_ignores_fabricated_children():
    # Synthetic hierarchies (postgres schema level) answer a readdir of
    # any missing name with fabricated children; only the parent listing
    # decides, so the original ENOENT stands.

    async def stat(_accessor, path, _index):
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        if target == "/":
            return ["/real.txt"]
        return [f"{target}/tables", f"{target}/views"]

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=readdir,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    bound = dir_aware_stat(ops, None, NO_NS)
    with pytest.raises(FileNotFoundError):
        await bound(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stat_probe_swallows_driver_errors():
    # A backend whose readdir raises a non-FS driver error for missing
    # names (lancedb: "Table ... was not found") must not leak it through
    # the probe; the original ENOENT stands.

    async def stat(_accessor, path, _index):
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        raise ValueError("Table 'nope.txt' was not found")

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=readdir,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    bound = dir_aware_stat(ops, None, NO_NS)
    with pytest.raises(FileNotFoundError):
        await bound(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stream_raises_eisdir_for_dirs():
    read = dir_aware_stream(_probe_ops(set(), implicit_dirs={"/sub"}), None,
                            NO_NS)
    with pytest.raises(IsADirectoryError):
        async for _ in read(PathSpec.from_str_path("/sub")):
            raise AssertionError("no data expected")


@pytest.mark.asyncio
async def test_dir_aware_stream_streams_files():
    read = dir_aware_stream(_probe_ops(set()), None, NO_NS)
    chunks = [c async for c in read(PathSpec.from_str_path("/f.txt"))]
    assert chunks == [b"data"]


class _Gate:
    """An EntryGate that refuses one path and remembers what it was asked."""

    def __init__(self, refused: str) -> None:
        self.scoped = True
        self.refused = refused
        self.asked: list[str] = []

    def check(self, virtual: str) -> None:
        self.asked.append(virtual)
        if virtual == self.refused:
            raise PermissionError(virtual)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual,
                    resolved=True)


@pytest.mark.asyncio
async def test_rule_guard_asks_the_bound_gate_and_leaves_stat_alone():
    from mirage.commands.builtin.generic_bind.adapter import with_rule_guard
    from mirage.context import reset_admission, set_admission
    calls: list[tuple[str, ...]] = []

    async def read_bytes(accessor, path, index=None):
        calls.append(("read", path.virtual))
        return b"x"

    async def stat(accessor, path, index=None):
        calls.append(("stat", path.virtual))
        return FileStat(name="k",
                        type=FileType.FILE,
                        content=ContentType.TEXT,
                        size=1)

    async def readdir(accessor, path, index=None):
        calls.append(("readdir", path.virtual))
        return ["/data/locked/y"]

    async def rename(accessor, src, dst):
        calls.append(("rename", src.virtual, dst.virtual))

    ops = with_rule_guard(
        CommandIO(readdir=readdir,
                  read_bytes=read_bytes,
                  read_stream=read_bytes,
                  stat=stat,
                  is_mounted=lambda a: True,
                  rename=rename))
    acc = NOOPAccessor()
    # No gate bound: every slot runs as is.
    assert await ops.read_bytes(acc, _spec("/data/locked/y")) == b"x"
    gate = _Gate(refused="/data/locked/y")
    token = set_admission(gate)
    try:
        with pytest.raises(PermissionError):
            await ops.read_bytes(acc, _spec("/data/locked/y"))
        # stat is not a guarded slot: deny is present and refused.
        assert (await ops.stat(acc, _spec("/data/locked/y"))).size == 1
        # readdir asks about the directory, never filters its names.
        assert await ops.readdir(acc,
                                 _spec("/data/locked")) == ["/data/locked/y"]
        # A pair op asks about both paths.
        with pytest.raises(PermissionError):
            await ops.rename(acc, _spec("/data/a"), _spec("/data/locked/y"))
        await ops.rename(acc, _spec("/data/a"), _spec("/data/b"))
    finally:
        reset_admission(token)
    assert gate.asked == [
        "/data/locked/y", "/data/locked", "/data/a", "/data/locked/y",
        "/data/a", "/data/b"
    ]
    assert ("read", "/data/locked/y") in calls
    assert ("rename", "/data/a", "/data/locked/y") not in calls
    assert ("rename", "/data/a", "/data/b") in calls
