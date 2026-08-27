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
import stat as stat_bits

import pytest

from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.nfs.fs import MirageNFS
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, MountMode
from mirage.workspace import Workspace

HELLO = b"hello world"
NESTED = b"nested"


class SizelessOps:
    """Ops proxy that strips stat sizes.

    Stands in for an API-backed resource whose byte length is unknown
    until the content is fetched, which is the one place the two
    adapters are allowed to answer differently.
    """

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def stat(self, path: str) -> FileStat:
        result = await self._inner.stat(path)
        return result.model_copy(update={"size": None})


def _seed(ws: Workspace, loop: asyncio.AbstractEventLoop) -> Workspace:
    """Populate one workspace with the shared fixture.

    Args:
        ws (Workspace): the workspace to seed.
        loop (asyncio.AbstractEventLoop): loop to drive the seeding.

    Returns:
        Workspace: the seeded workspace.
    """
    loop.run_until_complete(ws.execute("tee /a.txt", stdin=HELLO))
    loop.run_until_complete(ws.execute("mkdir /sub"))
    loop.run_until_complete(ws.execute("tee /sub/b.txt", stdin=NESTED))
    return ws


class Pair:
    """The two adapters over identical, independent workspaces.

    They cannot share one workspace: `MountCore` drives its ops from a
    private loop on its own thread, and the nfs adapter is awaited on
    this test's loop, so one tree would be mutated from two loops at
    once. Two trees seeded the same way answer the same questions.

    Args:
        loop (asyncio.AbstractEventLoop): loop the nfs side runs on.
        sizeless (bool): wrap both op facades so stat reports no size.
    """

    def __init__(self,
                 loop: asyncio.AbstractEventLoop,
                 sizeless: bool = False) -> None:
        self._loop = loop
        fuse_ws = _seed(Workspace({"/": RAMResource()}, mode=MountMode.WRITE),
                        loop)
        nfs_ws = _seed(Workspace({"/": RAMResource()}, mode=MountMode.WRITE),
                       loop)
        fuse_ops = SizelessOps(fuse_ws.ops) if sizeless else fuse_ws.ops
        nfs_ops = SizelessOps(nfs_ws.ops) if sizeless else nfs_ws.ops
        self.core = MountCore(fuse_ops)
        self.nfs = MirageNFS(nfs_ops)

    def run(self, coro):
        """Drive one nfs coroutine to completion.

        Args:
            coro: the coroutine to run.

        Returns:
            Any: whatever the coroutine returns.
        """
        return self._loop.run_until_complete(coro)

    def nfs_id(self, *parts: str) -> int:
        """Resolve a path to a fileid the way a client walks it.

        Args:
            parts (str): path components under the root.

        Returns:
            int: the entry's file id.
        """
        fileid = self.nfs.root_dir()
        for part in parts:
            fileid = self.run(self.nfs.lookup(fileid, part))
        return fileid

    def nfs_attrs(self, *parts: str) -> tuple[bool, bool, int]:
        """(is_dir, is_symlink, size) for a path, nfs side."""
        attrs = self.run(self.nfs.getattr(self.nfs_id(*parts)))
        return attrs.is_dir, attrs.is_symlink, attrs.size

    def fuse_attrs(self, path: str) -> tuple[bool, bool, int]:
        """(is_dir, is_symlink, size) for a path, fuse side."""
        entry = self.core.getattr(path)
        mode = entry["st_mode"]
        return (bool(stat_bits.S_ISDIR(mode)), bool(stat_bits.S_ISLNK(mode)),
                entry["st_size"])


@pytest.fixture
def pair():
    loop = asyncio.new_event_loop()
    try:
        yield Pair(loop)
    finally:
        loop.close()


@pytest.fixture
def sizeless_pair():
    loop = asyncio.new_event_loop()
    try:
        yield Pair(loop, sizeless=True)
    finally:
        loop.close()


def errno_of(call) -> int:
    """The errno an adapter's failure classifies to.

    Both adapters raise ordinary exceptions and both are classified by
    the same table, which is what makes the comparison meaningful.

    Args:
        call: a zero-argument callable expected to raise.

    Returns:
        int: the classified errno.
    """
    try:
        call()
    except Exception as exc:
        return classify_error(exc)
    raise AssertionError("expected the call to fail")


def test_file_attrs_agree(pair):
    assert pair.fuse_attrs("/a.txt") == pair.nfs_attrs("a.txt")
    assert pair.nfs_attrs("a.txt") == (False, False, len(HELLO))


def test_directory_attrs_agree(pair):
    assert pair.fuse_attrs("/sub") == pair.nfs_attrs("sub")
    assert pair.nfs_attrs("sub")[0] is True


def test_a_missing_path_classifies_to_the_same_errno(pair):
    fuse = errno_of(lambda: pair.core.getattr("/nope.txt"))
    nfs = errno_of(lambda: pair.nfs_id("nope.txt"))
    assert fuse == nfs


def test_readdir_names_agree(pair):
    # The fuse core prepends "." and ".." because libfuse's readdir
    # must emit them; NFSv3 carries them in the reply header instead,
    # so the comparison is over real entries.
    fuse = [n for n in pair.core.readdir("/") if n not in (".", "..")]
    nfs = sorted(e.name
                 for e in pair.run(pair.nfs.readdir(pair.nfs.root_dir())))
    assert fuse == nfs


def test_whole_file_reads_agree(pair):
    fuse = pair.core.read("/a.txt", len(HELLO), 0, None)
    nfs = pair.run(pair.nfs.read(pair.nfs_id("a.txt"), 0, len(HELLO)))
    assert fuse == nfs == HELLO


def test_offset_reads_agree(pair):
    fuse = pair.core.read("/a.txt", 5, 6, None)
    nfs = pair.run(pair.nfs.read(pair.nfs_id("a.txt"), 6, 5))
    assert fuse == nfs == b"world"


def test_a_write_is_readable_before_it_is_stored_on_both(pair):
    # The adapters buffer differently -- fuse merges through a handle,
    # nfs holds a per-fileid buffer flushed on an idle timer -- and the
    # point of the nfs overlay is that a client cannot tell.
    pair.core.write("/a.txt", b"HELLO", 0, None)
    fileid = pair.nfs_id("a.txt")
    pair.run(pair.nfs.write(fileid, 0, b"HELLO"))

    assert pair.core.read("/a.txt", len(HELLO), 0, None) == pair.run(
        pair.nfs.read(fileid, 0, len(HELLO)))
    assert pair.fuse_attrs("/a.txt") == pair.nfs_attrs("a.txt")


def test_a_write_past_the_end_grows_the_file_the_same_way(pair):
    pair.core.write("/a.txt", b"!", len(HELLO), None)
    fileid = pair.nfs_id("a.txt")
    pair.run(pair.nfs.write(fileid, len(HELLO), b"!"))
    assert pair.fuse_attrs("/a.txt")[2] == pair.nfs_attrs("a.txt")[2]
    assert pair.nfs_attrs("a.txt")[2] == len(HELLO) + 1


def test_symlink_and_readlink_agree(pair):
    # MountCore names the link first (`symlink(link, target)`), the
    # nfs trait names the parent and the link's name; both store the
    # target verbatim.
    pair.core.symlink("/lnk", "a.txt")
    pair.run(pair.nfs.symlink(pair.nfs.root_dir(), "lnk", "a.txt"))

    assert pair.core.readlink("/lnk") == pair.run(
        pair.nfs.readlink(pair.nfs_id("lnk")))
    assert pair.fuse_attrs("/lnk")[1] == pair.nfs_attrs("lnk")[1] is True


def test_mkdir_then_stat_agrees(pair):
    pair.core.mkdir("/fresh")
    pair.run(pair.nfs.mkdir(pair.nfs.root_dir(), "fresh"))
    assert pair.fuse_attrs("/fresh") == pair.nfs_attrs("fresh")


def test_rename_agrees(pair):
    pair.core.rename("/a.txt", "/renamed.txt")
    root = pair.nfs.root_dir()
    pair.run(pair.nfs.rename(root, "a.txt", root, "renamed.txt"))

    assert pair.fuse_attrs("/renamed.txt") == pair.nfs_attrs("renamed.txt")
    assert errno_of(lambda: pair.core.getattr("/a.txt")) == errno_of(
        lambda: pair.nfs_id("a.txt"))


def test_unlink_agrees(pair):
    pair.core.unlink("/a.txt")
    pair.run(pair.nfs.remove(pair.nfs.root_dir(), "a.txt"))
    assert errno_of(lambda: pair.core.getattr("/a.txt")) == errno_of(
        lambda: pair.nfs_id("a.txt"))


def test_truncate_agrees(pair):
    pair.core.truncate("/a.txt", 5)
    pair.run(pair.nfs.set_size(pair.nfs_id("a.txt"), 5))
    assert pair.fuse_attrs("/a.txt") == pair.nfs_attrs("a.txt")
    assert pair.core.read("/a.txt", 99, 0, None) == pair.run(
        pair.nfs.read(pair.nfs_id("a.txt"), 0, 99)) == HELLO[:5]


def test_a_size_unknown_file_stats_zero_on_both(sizeless_pair):
    # Neither adapter may invent a size it cannot know.
    assert sizeless_pair.fuse_attrs("/a.txt")[2] == 0
    assert sizeless_pair.nfs_attrs("a.txt")[2] == 0


def test_size_unknown_bytes_agree_when_the_bytes_are_asked_for(sizeless_pair):
    # Both adapters answer a READ with the real content: neither one
    # truncates to the size it stated. The size-unknown limitation is
    # not that nfs reads empty here -- it is that a client never asks,
    # which is the next test.
    fh = sizeless_pair.core.open("/a.txt")
    fuse = sizeless_pair.core.read("/a.txt", len(HELLO), 0, fh)
    nfs = sizeless_pair.run(
        sizeless_pair.nfs.read(sizeless_pair.nfs_id("a.txt"), 0, len(HELLO)))
    assert fuse == nfs == HELLO


def test_the_post_open_size_is_the_one_deliberate_divergence(sizeless_pair):
    # FUSE hydrates on OPEN, so the fstat that follows reports the real
    # length and every size-driven tool reads the whole file. NFSv3 has
    # no OPEN procedure to hang that on, so the size stays 0 and the
    # client stops there -- which is why the file reads empty through a
    # real mount (`sizeless_reads_empty` in integ/nfs/truth_nfs.json)
    # although the adapter above would have answered the bytes. This is
    # the limitation `check_sizes_nfs` warns about at mount time; if
    # this test ever fails because the two agree, the divergence was
    # closed and the warning and its docs should go with it.
    fh = sizeless_pair.core.open("/a.txt")
    assert sizeless_pair.core.getattr("/a.txt", fh)["st_size"] == len(HELLO)
    assert sizeless_pair.nfs_attrs("a.txt")[2] == 0
