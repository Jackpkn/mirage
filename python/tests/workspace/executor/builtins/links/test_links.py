import pytest

from mirage.policy import Action, Deny, OpsContext, Policy
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


class PinLinks(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.op == "unlink" and ctx.path.virtual.endswith(".pinned"):
            return Deny("pinned")
        return None


@pytest.mark.asyncio
async def test_rm_of_a_link_goes_through_the_door():
    # The strip used to write the node table directly, so a pre_ops
    # policy protecting a link never fired for `rm` while it fired for
    # every other door (the FUSE unlink hole, one tier up). The mount is
    # writable, so only the policy can be what refuses.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   policies=[PinLinks()])
    await ws.execute("echo b > /data/f.txt")
    await ws.execute("ln -s f.txt /data/lk.pinned")
    r = await ws.execute("rm /data/lk.pinned")
    assert r.exit_code == 1
    assert r.stderr == (b"rm: cannot remove '/data/lk.pinned': "
                        b"Permission denied\n")
    assert ws.namespace.is_link("/data/lk.pinned")


@pytest.mark.asyncio
async def test_rm_of_a_link_on_read_turf_names_the_mount():
    # The mount voice, byte for byte what `rm` of a backend file on the
    # same grant answers, because one grant must not describe itself two
    # ways depending on whether the name it stopped was a link.
    ws = _ws()
    await ws.execute("echo b > /data/f.txt; ln -s f.txt /data/lk")
    ws.create_session("agent", mounts={"/data/": "read"})
    r = await ws.execute("rm /data/lk", session_id="agent")
    assert r.exit_code == 1
    assert r.stderr == b"rm: read-only mount at /data/\n"
    assert ws.namespace.is_link("/data/lk")


@pytest.mark.asyncio
async def test_ln_and_mv_name_the_mount_too():
    # Same rule for the other two verbs that write the node table: `ln`
    # answers as `touch` does on a read-only mount, and `mv` as `mv` of
    # a backend file does.
    ws = _ws()
    await ws.execute("echo b > /data/f.txt; ln -s f.txt /data/lk")
    ws.create_session("agent", mounts={"/data/": "read"})
    ln = await ws.execute("ln -s f.txt /data/lk2", session_id="agent")
    mv = await ws.execute("mv /data/lk /data/lk3", session_id="agent")
    assert ln.exit_code == 1
    assert ln.stderr == b"ln: read-only mount at /data/\n"
    assert mv.exit_code == 1
    assert mv.stderr == b"mv: read-only mount at /data/\n"
    assert ws.namespace.readlink("/data/lk") == "f.txt"


@pytest.mark.asyncio
async def test_a_refused_link_operand_keeps_the_rest_going():
    # GNU rm reports the operand it could not remove and removes the
    # others; the backend half of the line still runs and the exit code
    # says something failed.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   policies=[PinLinks()])
    await ws.execute("echo b > /data/f.txt")
    await ws.execute("ln -s f.txt /data/lk.pinned; ln -s f.txt /data/lk")
    r = await ws.execute("rm /data/lk.pinned /data/lk /data/f.txt")
    assert r.exit_code == 1
    assert r.stderr == (b"rm: cannot remove '/data/lk.pinned': "
                        b"Permission denied\n")
    assert ws.namespace.is_link("/data/lk.pinned")
    assert not ws.namespace.is_link("/data/lk")
    assert (await ws.execute("test -e /data/f.txt; echo $?")).stdout == b"1\n"


@pytest.mark.asyncio
async def test_rm_f_still_reports_a_mode_refusal():
    # GNU -f silences only the absent; EROFS is not ENOENT.
    ws = _ws()
    await ws.execute("echo b > /data/f.txt; ln -s f.txt /data/lk")
    ws.create_session("agent", mounts={"/data/": "read"})
    r = await ws.execute("rm -f /data/lk", session_id="agent")
    assert r.exit_code == 1
    assert r.stderr == b"rm: read-only mount at /data/\n"


@pytest.mark.asyncio
async def test_rm_f_silences_a_hidden_link():
    # A hidden link answers ENOENT (the no-name-leak rule), which is
    # exactly what -f silences; without -f the miss is reported.
    ws = _ws()
    await ws.execute("echo b > /data/f.txt; ln -s f.txt /data/lk.sec")
    ws.create_session("agent", profile={"paths": {"hide": ["/data/lk.sec"]}})
    silent = await ws.execute("rm -f /data/lk.sec", session_id="agent")
    loud = await ws.execute("rm /data/lk.sec", session_id="agent")
    assert silent.exit_code == 0
    assert silent.stderr in (None, b"")
    assert loud.exit_code == 1
    assert loud.stderr == (b"rm: cannot remove '/data/lk.sec': "
                           b"No such file or directory\n")
    assert ws.namespace.is_link("/data/lk.sec")


@pytest.mark.asyncio
async def test_one_read_only_mount_speaks_once():
    # The refusal names the mount, not the operand, so it is one fact
    # however many operands tripped it -- including the backend operands
    # the command tier refuses separately, whose line is the same line.
    ws = _ws()
    await ws.execute("echo b > /data/f.txt")
    await ws.execute("ln -s f.txt /data/l1; ln -s f.txt /data/l2")
    ws.create_session("agent", mounts={"/data/": "read"})
    for line in ("rm /data/l1 /data/l2", "rm /data/l1 /data/f.txt",
                 "rm /data/l1 /data/l2 /data/f.txt"):
        r = await ws.execute(line, session_id="agent")
        assert r.exit_code == 1, line
        assert r.stderr == b"rm: read-only mount at /data/\n", line
    assert ws.namespace.is_link("/data/l1")
    assert ws.namespace.is_link("/data/l2")
