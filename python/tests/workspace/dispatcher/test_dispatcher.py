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

from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.policy import (Action, CommandRule, Deny, OpsContext, Policies,
                           Policy, PolicyDenied)
from mirage.policy.rule import RulePolicy
from mirage.resource.ram import RAMResource
from mirage.types import ConsistencyPolicy, HiddenPaths, MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.dispatcher import Dispatcher
from mirage.workspace.session import Session


class DenyLocked(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.path.virtual.startswith("/data/locked/"):
            return Deny("locked\n")
        return None


class DenyWrites(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.write:
            return Deny("no writes\n")
        return None


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path="",
                    raw_path=virtual,
                    resolved=True)


def _dispatcher(policies: Policies) -> tuple[Dispatcher, MagicMock]:
    namespace = MagicMock()
    namespace.ensure_loaded = AsyncMock()
    namespace.follow = MagicMock(side_effect=lambda p: p)
    mount = MagicMock()
    mount.prefix = "/data/"
    mount.resource.caches_reads = True
    mount.execute_op = AsyncMock(return_value=b"cold")
    namespace.try_mount_for = MagicMock(return_value=mount)
    namespace.registry.policies = policies
    cache = MagicMock()
    cache.get = AsyncMock(return_value=b"warm")
    dispatcher = Dispatcher(namespace, cache, ConsistencyPolicy.LAZY)
    reconciler = MagicMock()
    reconciler.may_serve_cached = AsyncMock(return_value=True)
    dispatcher._reconciler = reconciler
    return dispatcher, cache


@pytest.mark.asyncio
async def test_warm_cache_read_cannot_bypass_pre_ops():
    # The #241 failure class: a cached read served without consulting
    # the policy would make the cache a policy bypass. The hook fires
    # before the cache lookup, so the warm path refuses identically.
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, cache = _dispatcher(policies)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    cache.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_warm_cache_read_serves_when_no_policy_objects():
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, cache = _dispatcher(policies)
    result, _ = await dispatcher.dispatch("read", _path("/data/open/a.txt"))
    assert result == b"warm"
    cache.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_setattr_classifies_as_a_write():
    # touch on an existing file mutates via setattr, which is absent
    # from the dispatcher's own invalidation set; the policy write
    # classification must still cover it.
    policies = Policies()
    policies.add(DenyWrites())
    dispatcher, _ = _dispatcher(policies)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("setattr", _path("/data/a.txt"))
    result, _ = await dispatcher.dispatch("stat", _path("/data/a.txt"))
    assert result == b"cold"


@pytest.mark.asyncio
async def test_symlink_classifies_as_a_write():
    # A symlink create is a name-plane write the door itself answers;
    # the policy write classification must cover it like any mutation.
    policies = Policies()
    policies.add(DenyWrites())
    dispatcher, _ = _dispatcher(policies)
    ns = dispatcher._namespace
    ns.registry.mounts = MagicMock(
        return_value=[ns.try_mount_for.return_value])
    ns.symlink = AsyncMock()
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("symlink", _path("/data/lk"), target="x")
    ns.symlink.assert_not_awaited()


@pytest.mark.asyncio
async def test_readlink_answers_from_the_namespace():
    # readlink is the read twin: the namespace table is the authority,
    # never a backend, and the operand is not rewritten through follow.
    dispatcher, _ = _dispatcher(Policies())
    ns = dispatcher._namespace
    ns.registry.mounts = MagicMock(
        return_value=[ns.try_mount_for.return_value])
    ns.readlink = MagicMock(return_value="x.txt")
    result, _ = await dispatcher.dispatch("readlink", _path("/data/lk"))
    assert result == "x.txt"
    ns.follow.assert_not_called()


@pytest.mark.asyncio
async def test_spec_op_twin_holds_on_the_dispatch_door():
    policies = Policies()
    policies.add(
        RulePolicy(CommandRule(reason="frozen", paths=("/data/locked/*", ))))
    dispatcher, _ = _dispatcher(policies)
    with pytest.raises(PolicyDenied) as excinfo:
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    assert "frozen" in str(excinfo.value)


def _structure_only(dispatcher) -> None:
    """Point the mocks at a path no mount serves but structure knows:
    try_mount_for misses, while a mount deeper down makes the namespace
    answer readdir/stat for its parent."""
    namespace = dispatcher._namespace
    namespace.try_mount_for = MagicMock(return_value=None)
    deep = MagicMock()
    deep.prefix = "/data/locked/inner/deep/"
    namespace.registry.mounts = MagicMock(return_value=[deep])
    namespace.symlink_targets = MagicMock(return_value={})


@pytest.mark.asyncio
async def test_structure_fallback_still_clears_admission():
    # A path with no owning mount can still answer readdir/stat from
    # namespace structure. That synthetic answer must pass the same
    # gates as a backend one, or "no mount here" is a policy bypass.
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, _ = _dispatcher(policies)
    _structure_only(dispatcher)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("readdir", _path("/data/locked/inner"))
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("stat", _path("/data/locked/inner"))


@pytest.mark.asyncio
async def test_structure_fallback_serves_when_no_policy_objects():
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    result, _ = await dispatcher.dispatch("readdir",
                                          _path("/data/locked/inner"))
    assert result == ["/data/locked/inner/deep"]


@pytest.fixture
def scoped_session():
    """Bind a session whose role hides the parent mount's own content,
    leaving the mount nested below it reachable."""
    session = Session(session_id="agent",
                      hidden_paths=HiddenPaths(paths=("/data/locked/other",
                                                      "/data/locked/f.txt")))
    token = set_current_session(session)
    yield session
    reset_current_session(token)


@pytest.mark.asyncio
async def test_a_structure_answer_still_clears_the_sessions_hides(
        scoped_session):
    # The synthetic answer passes the session's view as well as the
    # policy chain: it is produced above every backend, so a path the
    # role hides would otherwise be served by the one code path that
    # asks no mount anything.
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    result, _ = await dispatcher.dispatch("readdir",
                                          _path("/data/locked/inner"))
    assert result == ["/data/locked/inner/deep"]
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch("readdir", _path("/data/locked/other"))


@pytest.mark.asyncio
async def test_a_hidden_path_denies_a_read_and_refuses_a_create(
        scoped_session):
    # The hide's two verdicts, at the door every surface comes through:
    # absent on a read, EACCES on a create, and a write is never served
    # from structure.
    dispatcher, _ = _dispatcher(Policies())
    _structure_only(dispatcher)
    with pytest.raises(FileNotFoundError):
        await dispatcher.dispatch("stat", _path("/data/locked/other"))
    with pytest.raises(PermissionError):
        await dispatcher.dispatch("write",
                                  _path("/data/locked/f.txt"),
                                  data=b"x")


@pytest.mark.asyncio
async def test_unlink_removes_a_namespace_link():
    # The door creates links (`symlink`), so it has to remove them too:
    # a link has no backend entry, so forwarding the unlink reaches a
    # backend that has never heard of the name and answers ENOENT,
    # leaving the link in place. That is what left `git checkout` unable
    # to drop a link the other branch does not have.
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.execute("ln -s a.txt /ram/link")
        assert ws._namespace.is_link("/ram/link")
        await ws.dispatch("unlink", PathSpec.from_str_path("/ram/link"))
        assert not ws._namespace.is_link("/ram/link")
        listing = await ws.execute("ls /ram")
        assert b"link" not in (listing.stdout or b"")


@pytest.mark.asyncio
async def test_unlink_of_an_ordinary_file_still_reaches_the_backend():
    with Workspace({"/ram/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.execute("echo hi > /ram/a.txt")
        await ws.dispatch("unlink", PathSpec.from_str_path("/ram/a.txt"))
        listing = await ws.execute("ls /ram")
        assert (listing.stdout or b"").strip() == b""
