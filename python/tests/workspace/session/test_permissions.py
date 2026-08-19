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
import re

import pytest
from pydantic import ValidationError

from mirage.policy.types import DEFAULT_DENY_REASON, CommandRule
from mirage.resource.ram import RAMResource
from mirage.types import HiddenPaths, HiddenVars, MountMode
from mirage.workspace import Workspace
from mirage.workspace.session import SessionProfile
from mirage.workspace.session.permissions import (CommandsBlock,
                                                  MountPermissions, PathsBlock,
                                                  VarsBlock,
                                                  WorkspacePermissions)
from mirage.workspace.session.state import seed_var


def test_profile_from_dict_regroups_paths_and_vars():
    p = SessionProfile.model_validate({
        "extends": "default",
        "cwd": "/scratch",
        "env": {
            "PAGER": "cat"
        },
        "mounts": {
            "/repo": "r",
            "scratch/": "rwx"
        },
        "paths": {
            "hide": ["/repo/.env", "*.pem"]
        },
        "vars": {
            "hide": ["AWS_*"]
        },
    })
    assert p.extends == "default"
    assert p.cwd == "/scratch"
    assert p.env == {"PAGER": "cat"}
    assert p.mounts == {"/repo": MountMode.READ, "/scratch": MountMode.EXEC}
    assert p.paths == PathsBlock(hide=("/repo/.env", "*.pem"))
    assert p.vars == VarsBlock(hide=("AWS_*", ))


def test_profile_unsaid_fields_are_none_so_inheritance_can_tell():
    p = SessionProfile()
    assert (p.extends, p.cwd, p.env, p.mounts, p.paths, p.vars) == (None, ) * 6


def test_profile_mounts_list_form_keeps_each_mounts_own_mode():
    assert SessionProfile(mounts=["/repo", "scratch"]).mounts == ("/repo",
                                                                  "/scratch")
    assert SessionProfile(mounts="/repo").mounts == ("/repo", )


@pytest.mark.parametrize("mounts,message", [
    (["/repo", 7], "mounts[1] must be a string"),
    ({
        7: "read"
    }, "mounts keys must be strings"),
    ({
        "/repo": ["read"]
    }, "mounts[/repo] must be a mode name or alias"),
    ({
        "/repo": 7
    }, "mounts[/repo] must be a mode name or alias"),
    (7, "mounts must be a mapping or a list of strings"),
    ({"/repo"}, "mounts must be a mapping or a list of strings"),
])
def test_profile_mounts_rejects_what_typescript_rejects(mounts, message):
    # The message is asserted, not just the type: a mode that is not a
    # string used to reach parse_mount_mode and come back as a bare
    # TypeError (unhashable dict/list key), which is not the ValueError
    # the loader's contract promises.
    with pytest.raises(ValidationError, match=re.escape(message)):
        SessionProfile.model_validate({"mounts": mounts})


def test_profile_rejects_unknown_and_unshipped_fields():
    for bad in ({
            "hidden_paths": {}
    }, {
            "hidden_vars": {}
    }, {
            "commands": {
                "deny": []
            }
    }, {
            "paths": {
                "show": {}
            }
    }, {
            "vars": {
                "mask": []
            }
    }):
        with pytest.raises(ValidationError):
            SessionProfile.model_validate(bad)


def test_profile_is_frozen():
    p = SessionProfile(cwd="/x")
    with pytest.raises(ValidationError):
        p.cwd = "/y"  # type: ignore[misc]


def test_workspace_permissions_deny_accepts_rules_and_bare_names():
    w = WorkspacePermissions.model_validate({
        "commands": {
            "deny": [{
                "reason": "no deletes",
                "commands": ["rm"],
                "paths": ["/repo/*"]
            }, "python3", {
                "commands": ["shred"]
            }]
        },
        "paths": {
            "hide": ["/shared/finance"]
        },
    })
    assert w.commands == CommandsBlock(deny=(
        CommandRule(
            reason="no deletes", commands=("rm", ), paths=("/repo/*", )),
        CommandRule(reason=DEFAULT_DENY_REASON, commands=("python3", )),
        CommandRule(reason=DEFAULT_DENY_REASON, commands=("shred", )),
    ))
    assert w.paths == PathsBlock(hide=("/shared/finance", ))
    assert WorkspacePermissions() == WorkspacePermissions(
        commands=CommandsBlock(), paths=PathsBlock())


@pytest.mark.parametrize("deny", ["rm", {"rm": "no"}, 7])
def test_workspace_permissions_deny_is_a_list_not_a_scalar(deny):
    with pytest.raises(ValidationError,
                       match=re.escape("commands.deny must be a list")):
        WorkspacePermissions.model_validate({"commands": {"deny": deny}})


@pytest.mark.parametrize("rule", [
    {
        "commands": "rm"
    },
    {
        "reason": "no",
        "paths": "/repo/secret"
    },
    {
        "commands": ["rm", 3]
    },
    {
        "reason": 7,
        "commands": ["rm"]
    },
])
def test_deny_rule_refuses_scalar_lists_and_non_string_reasons(rule):
    # `commands: rm` would tuple() into ('r', 'm') and leave rm allowed;
    # the document fails to load instead, as it does in TypeScript.
    with pytest.raises(ValidationError):
        WorkspacePermissions.model_validate({"commands": {"deny": [rule]}})


def test_workspace_permissions_rejects_profile_only_and_unknown_fields():
    for bad in ({
            "mounts": {
                "/a": "r"
            }
    }, {
            "commands": {
                "allow": ["ls"]
            }
    }, {
            "commands": {
                "deny": [{
                    "reason": "x",
                    "command": ["rm"]
                }]
            }
    }, {
            "vars": {
                "hide": ["X"]
            }
    }):
        with pytest.raises(ValidationError):
            WorkspacePermissions.model_validate(bad)


def test_mount_permissions_is_paths_only_in_this_rung():
    m = MountPermissions.model_validate({"paths": {"hide": ["*.pem", ".env"]}})
    assert m.paths == PathsBlock(hide=("*.pem", ".env"))
    with pytest.raises(ValidationError):
        MountPermissions.model_validate({"commands": {"deny": ["rm"]}})


def _ws() -> Workspace:
    a = RAMResource()
    a._store.files["/x.txt"] = b"public\n"
    a._store.files["/secrets/token.txt"] = b"s3cr3t\n"
    a._store.dirs.add("/secrets")
    b = RAMResource()
    b._store.files["/y.txt"] = b"other\n"
    return Workspace({
        "/a": (a, MountMode.WRITE),
        "/b": (b, MountMode.WRITE)
    },
                     mode=MountMode.WRITE)


ANALYST = SessionProfile(mounts={"/a": "write"},
                         paths=PathsBlock(hide=("/a/secrets", )),
                         vars=VarsBlock(hide=("SLACK_TOKEN", )),
                         env={"ROLE": "analyst"})


def test_profile_applies_every_narrowing_field():
    ws = _ws()
    sess = ws.create_session("agent", profile=ANALYST)
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.WRITE
    assert "/b" not in sess.mount_modes
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    assert sess.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ))
    assert sess.env["ROLE"] == "analyst"


def test_one_profile_serves_many_sessions():
    # A profile is a role, not a session: frozen, so two agents share
    # one object and neither can bend the other's view.
    ws = _ws()
    s1 = ws.create_session("agent1", profile=ANALYST)
    s2 = ws.create_session("agent2", profile=ANALYST)
    assert s1.hidden_paths == s2.hidden_paths
    seed_var(s1, "ROLE", "changed")
    assert s2.env["ROLE"] == "analyst"


def test_explicit_mounts_tighten_the_profile_never_widen_it():
    # Inline narrowing intersects the profile (design 3.4): a mount the
    # profile never granted stays ungranted, and a granted one keeps the
    # weaker of the two modes.
    ws = _ws()
    sess = ws.create_session("agent",
                             mounts={
                                 "/a": "read",
                                 "/b": "read"
                             },
                             profile=ANALYST)
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.READ
    assert "/b" not in sess.mount_modes
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ))


def test_profiled_session_is_narrowed_end_to_end():
    ws = _ws()
    ws.create_session("agent", profile=ANALYST)

    async def run():
        listing = await ws.execute("ls /a", session_id="agent")
        denied = await ws.execute("cat /a/secrets/token.txt",
                                  session_id="agent")
        role = await ws.execute('echo "$ROLE"', session_id="agent")
        return (await listing.stdout_str(), denied, await role.stdout_str())

    listing_out, denied, role_out = asyncio.run(run())
    assert "x.txt" in listing_out
    assert "secrets" not in listing_out
    assert denied.exit_code != 0
    assert role_out == "analyst\n"


def test_profile_env_reaches_the_process_view():
    # A profile's env is a process environment, so every name in it is
    # exported. Seeded plain, `$ROLE` expanded while `env`, an installed
    # CLI and a guest runtime all saw nothing, because all three read
    # `env_snapshot` and that is the exported set.
    ws = _ws()
    ws.create_session("agent", profile=ANALYST)

    async def run():
        listed = await ws.execute("env", session_id="agent")
        return await listed.stdout_str()

    assert "ROLE=analyst\n" in asyncio.run(run())


PROFILES = {
    "default":
    SessionProfile(cwd="/b",
                   env={"PAGER": "cat"},
                   mounts={
                       "/a": "rw",
                       "/b": "rwx"
                   }),
    "reviewer":
    SessionProfile(extends="default",
                   mounts={
                       "/a": "r",
                       "/b": "rwx"
                   },
                   paths=PathsBlock(hide=("/a/secrets", ))),
}


def _profiled_ws() -> Workspace:
    a = RAMResource()
    a._store.files["/x.txt"] = b"public\n"
    a._store.files["/secrets/token.txt"] = b"s3cr3t\n"
    a._store.dirs.add("/secrets")
    return Workspace(
        {
            "/a": (a, MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE)
        },
        mode=MountMode.WRITE,
        profiles=PROFILES,
    )


def test_create_session_by_profile_name_resolves_the_chain():
    ws = _profiled_ws()
    sess = ws.create_session("agent", profile="reviewer")
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.READ
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    assert sess.cwd == "/b"
    assert sess.env["PAGER"] == "cat"


def test_create_session_without_a_profile_takes_the_default_one():
    ws = _profiled_ws()
    sess = ws.create_session("agent")
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.WRITE
    assert sess.hidden_paths is None
    assert sess.cwd == "/b"
    # A workspace with no default profile leaves the session unrestricted.
    plain = _ws().create_session("free")
    assert plain.mount_modes is None and plain.cwd == "/"


def test_default_profile_shapes_the_workspace_session_too():
    # The workspace's own session is a session created without a name,
    # so `profiles.default` reaches it: the primary agent starts in the
    # profile's cwd, sees its exported env and its mount ceilings, and
    # cannot see what it hides. A workspace with no default profile
    # leaves that session as it always was.
    ws = Workspace(
        {
            "/a": (RAMResource(), MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE)
        },
        mode=MountMode.WRITE,
        profiles={
            "default":
            SessionProfile(cwd="/b",
                           env={"PAGER": "cat"},
                           mounts={"/b": "rwx"},
                           paths=PathsBlock(hide=("/b/vault", ))),
        },
    )
    default = ws.get_session(ws.default_session_id)
    assert default.mount_modes is not None
    assert default.mount_modes["/b"] == MountMode.EXEC
    assert "/a" not in default.mount_modes
    assert default.hidden_paths == HiddenPaths(paths=("/b/vault", ))
    assert default.cwd == "/b"

    async def run():
        pwd = await ws.execute("pwd")
        pager = await ws.execute('echo "$PAGER"')
        other = await ws.execute("ls /a")
        vault = await ws.execute("mkdir /b/vault")
        return (await pwd.stdout_str(), await
                pager.stdout_str(), other.exit_code, vault.exit_code)

    pwd_out, pager_out, other_exit, vault_exit = asyncio.run(run())
    assert pwd_out == "/b\n"
    assert pager_out == "cat\n"
    assert other_exit != 0
    assert vault_exit != 0
    plain_ws = _ws()
    plain = plain_ws.get_session(plain_ws.default_session_id)
    assert plain.mount_modes is None and plain.hidden_paths is None


def test_create_session_rejects_an_unknown_profile_name():
    from mirage.policy.errors import PolicyError
    ws = _profiled_ws()
    with pytest.raises(PolicyError, match="unknown profile 'nope'"):
        ws.create_session("agent", profile="nope")


def test_workspace_rejects_a_broken_profile_chain_at_construction():
    from mirage.policy.errors import PolicyError
    with pytest.raises(PolicyError, match="extends unknown profile 'gone'"):
        Workspace({"/a": (RAMResource(), MountMode.WRITE)},
                  profiles={"orphan": SessionProfile(extends="gone")})


def test_inline_permissions_tighten_the_named_profile():
    ws = _profiled_ws()
    sess = ws.create_session("agent",
                             profile="reviewer",
                             permissions=SessionProfile(
                                 cwd="/a",
                                 mounts={"/a": "rw"},
                                 paths=PathsBlock(hide=("*.key", )),
                                 vars=VarsBlock(hide=("AWS_*", ))))
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.READ
    assert "/b" not in sess.mount_modes
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ),
                                            patterns=("*.key", ))
    assert sess.hidden_vars == HiddenVars(patterns=("AWS_*", ))
    assert sess.cwd == "/a"


def test_profile_cwd_is_where_the_session_starts():
    ws = _profiled_ws()
    ws.create_session("agent", profile="reviewer")

    async def run():
        out = await ws.execute("pwd", session_id="agent")
        return await out.stdout_str()

    assert asyncio.run(run()) == "/b\n"
