import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.links import (accepts_line,
                                                      follow_parent,
                                                      follow_paths, link_flags)


def _ws() -> Workspace:
    return Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


def test_link_flags_reads_the_known_letters():
    assert link_flags(["-sf", PathSpec.from_str_path("/data/a")],
                      "sfnvrT") == {"s", "f"}
    assert link_flags([PathSpec.from_str_path("/data/a")], "sfnvrT") == set()


@pytest.mark.asyncio
async def test_follow_parent_resolves_every_component_but_the_last():
    ws = _ws()
    await ws.execute("mkdir -p /data/real; ln -s /data/real /data/dlink")
    ns = ws.namespace
    assert follow_parent(ns, "/data/dlink/f2") == "/data/real/f2"
    assert follow_parent(ns, "/data/dlink") == "/data/dlink"


@pytest.mark.asyncio
async def test_follow_paths_follows_the_last_component_only_when_asked():
    ws = _ws()
    await ws.execute("mkdir -p /data/real; ln -s /data/real /data/dlink")
    ns = ws.namespace
    item = PathSpec.from_str_path("/data/dlink")
    kept = follow_paths(ns, [item], follow_last=False)
    assert kept[0].virtual == "/data/dlink"
    followed = follow_paths(ns, [item], follow_last=True)
    assert followed[0].virtual == "/data/real"
    slashed = follow_paths(ns, [PathSpec.from_str_path("/data/dlink/")],
                           follow_last=False)
    assert slashed[0].virtual == "/data/real/"


def test_accepts_line_refuses_what_the_command_layer_would():
    good = [PathSpec.from_str_path("/data/dlink")]
    assert accepts_line("rm", ("/data/dlink", ), good, "/data")
    assert not accepts_line("rm", ("--bogus", "/data/dlink"), good, "/data")
    two = [
        PathSpec.from_str_path("/data/a"),
        PathSpec.from_str_path("/data/b")
    ]
    assert not accepts_line("unlink", ("/data/a", "/data/b"), two, "/data")
