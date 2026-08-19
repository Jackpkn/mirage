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

from mirage.commands.cli.specs import cli_spec_for
from mirage.policy import (Action, ApprovalRequest, Ask, CallbackApprover,
                           CommandContext, Policy)
from mirage.policy.types import (DEFAULT_ASK_REASON, DEFAULT_DENY_REASON,
                                 CommandRule)
from mirage.resource.ram import RAMResource
from mirage.types import HiddenPaths, HiddenVars, MountMode
from mirage.workspace import Workspace
from mirage.workspace.mount.spec import Mount
from mirage.workspace.session import SessionProfile
from mirage.workspace.session.state import seed_var

from mirage.workspace.session.permissions import (  # isort: skip
    CommandsBlock, MountCommandsBlock, MountPermissions, PathsBlock, VarsBlock,
    WorkspacePermissions)


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
                "hide": []
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


def test_profile_commands_block_takes_allow_ask_and_deny():
    p = SessionProfile.model_validate({
        "commands": {
            "allow": ["ls", "git log"],
            "ask": [
                "git push", {
                    "reason": "sign-off",
                    "commands": ["rm"],
                    "paths": ["/shared/*"]
                }
            ],
            "deny": [{
                "reason": "no",
                "commands": ["rm"],
                "paths": ["/repo/*"]
            }],
        }
    })
    assert p.commands is not None
    assert p.commands.allow == ("ls", "git log")
    # A bare ask entry carries the ask arm's default reason, not deny's.
    assert p.commands.ask[0] == CommandRule(reason=DEFAULT_ASK_REASON,
                                            commands=("git push", ))
    assert p.commands.ask[1] == CommandRule(reason="sign-off",
                                            commands=("rm", ),
                                            paths=("/shared/*", ))
    assert p.commands.deny[0].reason == "no"
    # Unstated allow is None (everything installed), not an empty list.
    assert SessionProfile.model_validate({
        "commands": {
            "deny": ["rm"]
        }
    }).commands.allow is None


@pytest.mark.parametrize("bad", [
    {
        "allow": "ls"
    },
    {
        "allow": ["ls", ""]
    },
    {
        "allow": ["ls", "  "]
    },
    {
        "ask": "git push"
    },
    {
        "ask": [""]
    },
    {
        "deny": [{
            "reason": "x",
            "commands": [""]
        }]
    },
    {
        "ask": [{
            "reason": "x",
            "mount": "/repo"
        }]
    },
])
def test_commands_block_refuses_scalars_blank_patterns_and_mount(bad):
    # A blank pattern is a prefix of every line, so it would allow, ask
    # about or deny every command; `mount` is the compiler's field.
    with pytest.raises(ValidationError):
        SessionProfile.model_validate({"commands": bad})


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
    # The workspace tier takes the whole commands block.
    w = WorkspacePermissions.model_validate(
        {"commands": {
            "allow": ["ls", "git"],
            "ask": ["git push"]
        }})
    assert w.commands.allow == ("ls", "git")
    assert w.commands.ask[0].commands == ("git push", )
    for bad in ({
            "mounts": {
                "/a": "r"
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


def test_mount_permissions_takes_paths_and_ask_deny_but_no_allow():
    m = MountPermissions.model_validate({"paths": {"hide": ["*.pem", ".env"]}})
    assert m.paths == PathsBlock(hide=("*.pem", ".env"))
    m = MountPermissions.model_validate(
        {"commands": {
            "deny": ["git push"],
            "ask": ["git rebase"]
        }})
    assert m.commands.deny[0].commands == ("git push", )
    assert m.commands.ask[0].commands == ("git rebase", )
    # What a session can see is the session's property, not an
    # operand's: a mount tier has no allow list.
    with pytest.raises(ValidationError):
        MountPermissions.model_validate({"commands": {"allow": ["ls"]}})


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


COMMANDS_DOC = WorkspacePermissions.model_validate({
    "commands": {
        "allow": [
            "ls", "cat", "echo", "rm", "git", "python3", "mkdir", "touch",
            "head", "xargs", "wc", "man", "find"
        ],
        "deny": [{
            "reason": "no deletes in the repo",
            "commands": ["rm"],
            "paths": ["/repo/*"]
        }, {
            "reason": "frozen",
            "paths": ["/repo/locked/*"]
        }],
    }
})
REVIEWER_COMMANDS = SessionProfile.model_validate({
    "commands": {
        "allow": ["ls", "cat", "echo", "git log", "git status", "xargs"]
    }
})


def _commands_ws() -> Workspace:
    # The frozen subtree is seeded on the resource: the pure path rule
    # holds at every op door, the host's `ws.ops` included.
    repo = RAMResource()
    repo._store.dirs.add("/locked")
    repo._store.files["/locked/y"] = b"y\n"
    ws = Workspace(
        {
            "/repo/":
            Mount(repo,
                  MountMode.WRITE,
                  permissions=MountPermissions(commands=MountCommandsBlock(
                      deny=[{
                          "reason": "history is read-only here",
                          "commands": ["git commit", "git reset --hard"]
                      }]))),
            "/scratch/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        permissions=COMMANDS_DOC,
        profiles={"reviewer": REVIEWER_COMMANDS},
    )
    ws.register_cli("git", cli_spec_for("git"))
    return ws


async def _line(ws: Workspace, line: str, sid: str | None = None):
    r = (await ws.execute(line, session_id=sid)
         if sid is not None else await ws.execute(line))
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_allow_list_hides_unlisted_tools_from_dispatch_and_enumerators():
    ws = _commands_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x")
        # An unlisted tool is not a command for the session: 127 before
        # any admission hook, and every enumerator agrees.
        assert await _line(ws,
                           "sort /repo/d/x") == (127, "",
                                                 "sort: command not found\n")
        assert await _line(ws,
                           "type sort; echo $?") == (0, "1\n",
                                                     "type: sort: not found\n")
        assert await _line(ws, "command -v sort; echo $?") == (0, "1\n", "")
        assert await _line(ws, "which sort; echo $?") == (0, "1\n", "")
        code, out, _ = await _line(ws, "man")
        assert code == 0 and "- cat" in out and "- sort" not in out
        assert (await _line(ws, "man sort"))[0] == 1
        # Grammar-tier builtins and functions are not subjects; a listed
        # tool runs; the workspace's own session is bound like any other.
        assert await _line(
            ws, "cd /repo && [ -f d/x ] && echo yes") == (0, "yes\n", "")
        assert await _line(ws, "f() { echo in-f; }; f") == (0, "in-f\n", "")
        assert (await _line(ws, "cat /repo/d/x"))[0] == 0
        # `man` and `history` are tool-tier builtins: hidden when unlisted.
        assert await _line(ws, "history") == (127, "",
                                              "history: command not found\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_profile_allow_list_intersects_with_the_workspace_tier():
    ws = _commands_ws()
    ws.create_session("rev", profile="reviewer")
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x")
        # Both tiers list `cat`; the workspace lists python3, the profile
        # does not; the profile lists `git log`, so `git` is visible but
        # a `git commit` line is covered by nothing (a refusal that names
        # the program, not "command not found").
        assert (await _line(ws, "cat /repo/d/x", "rev"))[0] == 0
        assert await _line(ws, "python3 -c 1",
                           "rev") == (127, "", "python3: command not found\n")
        assert (await _line(ws, "type git", "rev"))[0] == 0
        assert await _line(
            ws, "git commit -m x",
            "rev") == (126, "",
                       "git: policy denied: git commit is not allowed\n")
        # The verb walk normalizes the line: options before the verb are
        # not the verb, so `git -C /repo status` is `git status`.
        code, _, err = await _line(ws, "git -C /repo status", "rev")
        assert "not allowed" not in err
        # Nested runners re-enter the chokepoint: the hidden `rm` stays
        # hidden inside xargs, eval and a function body.
        assert await _line(ws, "echo /repo/d/x | xargs rm",
                           "rev") == (127, "", "rm: command not found\n")
        assert await _line(ws, "eval 'rm /repo/d/x'",
                           "rev") == (127, "", "rm: command not found\n")
        assert await _line(ws, "f() { rm /repo/d/x; }; f",
                           "rev") == (127, "", "rm: command not found\n")
        # An inline document tightens further: allow lists intersect.
        ws.create_session("tight",
                          profile="reviewer",
                          permissions=SessionProfile.model_validate(
                              {"commands": {
                                  "allow": ["cat", "git"]
                              }}))
        assert (await _line(ws, "cat /repo/d/x", "tight"))[0] == 0
        assert await _line(ws, "ls /repo",
                           "tight") == (127, "", "ls: command not found\n")
        code, _, err = await _line(ws, "git log", "tight")
        assert "not allowed" not in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_deny_rules_by_tier_scope_and_voice():
    ws = _commands_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x /scratch/z")
        # Operand-scoped: the GNU voice at 1, the operand as typed.
        assert await _line(
            ws,
            "cd /repo/d && rm x") == (1, "", "rm: x: no deletes in the repo\n")
        assert (await _line(ws, "rm /scratch/z"))[0] == 0
        # A pure path rule holds at the command plane for any command
        # and at the op door for every op, whatever door.
        assert await _line(
            ws,
            "cat /repo/locked/y") == (1, "", "cat: /repo/locked/y: frozen\n")
        with pytest.raises(PermissionError):
            await ws.ops.write("/repo/locked/y", b"changed")
        assert await ws.ops.read("/repo/d/x") == b""
        # Mount tier: applies when the line works inside the mount (cwd
        # under it, or a path under it), speaks first, whole command; the
        # verb walk reads `-C /repo reset --hard` as `git reset --hard`.
        assert await _line(ws, "cd /repo && git commit -m x") == (
            126, "", "git: policy denied: history is read-only here\n")
        assert await _line(ws, "cd /scratch && git -C /repo reset --hard") == (
            126, "", "git: policy denied: history is read-only here\n")
        code, _, err = await _line(ws, "cd /scratch && git commit -m x")
        assert "read-only" not in err
        code, _, err = await _line(ws, "cd /repo && git reset --soft HEAD")
        assert "read-only" not in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_find_delete_is_gated_at_the_op_door_not_by_a_named_rule():
    # mirage's find has no -exec; -delete is find's own action, not an
    # `rm` line, so a rule naming `rm` does not cover it (the same
    # honest limit as a guest's os.remove), while a pure path rule
    # does, at the op door the removal clears.
    ws = _commands_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x")
        await ws.execute("find /repo/d -name x -delete")
        assert (await _line(ws, "cat /repo/d/x"))[0] != 0
        assert await _line(ws, "find /repo/locked -name y -delete") == (
            1, "", "find: cannot delete '/repo/locked/y': frozen\n")
        assert (await _line(ws, "cat /repo/locked/y"))[0] == 1
        # The same rule holds for the host's own door, read or write.
        with pytest.raises(PermissionError):
            await ws.ops.read("/repo/locked/y")
    finally:
        await ws.close()


ASK_DOC = WorkspacePermissions.model_validate({
    "commands": {
        "ask": [{
            "reason": "sign-off",
            "commands": ["rm"]
        }, "head"],
        "deny": [{
            "reason": "no deletes in the repo",
            "commands": ["rm"],
            "paths": ["/repo/*"]
        }],
    }
})


class AskWc(Policy):
    """A coded condition that asks: every wc line."""

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "wc":
            return Ask("looks risky")
        return None


def _ask_ws(**kwargs) -> Workspace:
    ws = Workspace(
        {
            "/repo/": (RAMResource(), MountMode.WRITE),
            "/scratch/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        permissions=ASK_DOC,
        policies=[AskWc()],
        **kwargs,
    )
    return ws


@pytest.mark.asyncio
async def test_an_asked_line_is_refused_until_the_host_answers():
    ws = _ask_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x /scratch/z")
        # Asked: 126 in the requires-approval voice, quoting an id; the
        # request is on ws.approvals with what was asked; a retry quotes
        # the same id and adds nothing.
        code, _, err = await _line(ws, "rm /scratch/z")
        assert code == 126
        (request, ) = ws.approvals.list()
        assert err == (f"rm: requires approval: sign-off "
                       f"(approval {request.id})\n")
        assert (request.command, request.argv, request.cwd,
                request.paths) == ("rm", ("/scratch/z", ), "/",
                                   ("/scratch/z", ))
        assert request.session_id == ws._session_mgr.default_id
        assert await _line(ws, "rm /scratch/z") == (126, "", err)
        assert len(ws.approvals.list()) == 1
        # Granted once: the exact retry passes, and the next one asks.
        await ws.approvals.grant(request.id)
        assert ws.approvals.list() == ()
        assert (await _line(ws, "rm /scratch/z"))[0] == 0
        assert (await _line(ws, "cat /scratch/z"))[0] == 1
        code, _, err = await _line(ws, "rm /scratch/z")
        assert code == 126 and "requires approval" in err
        # A bare pattern asks with the default reason.
        code, _, err = await _line(ws, "head /repo/d/x")
        assert code == 126
        assert err.startswith("head: requires approval: no standing approval")
        # Denied: the retry is refused once in the deny voice, then the
        # question is open again.
        pending = {r.command: r for r in ws.approvals.list()}
        await ws.approvals.deny(pending["head"].id)
        assert await _line(ws, "head /repo/d/x") == (
            126, "", "head: policy denied: no standing approval\n")
        code, _, err = await _line(ws, "head /repo/d/x")
        assert code == 126 and "requires approval" in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_session_grant_covers_the_rule_and_a_deny_is_never_reopened():
    ws = _ask_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x /scratch/y "
                         "/scratch/z")
        code, _, _ = await _line(ws, "rm /scratch/y")
        assert code == 126
        (request, ) = ws.approvals.list()
        await ws.approvals.grant(request.id, "session")
        # Every rm line passes now, in any directory of the session ...
        assert (await _line(ws, "rm /scratch/y"))[0] == 0
        assert (await _line(ws, "cd /scratch && rm z"))[0] == 0
        # ... except where a deny rule speaks: the deny arm runs before
        # the ask arm, so no grant can re-open it.
        assert await _line(
            ws,
            "cd /repo/d && rm x") == (1, "", "rm: x: no deletes in the repo\n")
        # The grant is session state: on the record, and not another
        # session's.
        default = ws._session_mgr.get(ws._session_mgr.default_id)
        assert default.to_dict()["grants"][0]["decision"] == "allow_session"
        ws.create_session("other")
        await ws.execute("touch /scratch/w", session_id="other")
        code, _, err = await _line(ws, "rm /scratch/w", "other")
        assert code == 126 and "requires approval" in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_coded_ask_routes_to_the_same_door():
    ws = _ask_ws()
    try:
        await ws.execute("touch /scratch/z")
        code, _, err = await _line(ws, "wc -c /scratch/z")
        assert code == 126
        (request, ) = ws.approvals.list()
        assert err == (f"wc: requires approval: looks risky "
                       f"(approval {request.id})\n")
        # The synthesized rule names the program, so a session grant
        # covers every wc line.
        assert request.rule == CommandRule(reason="looks risky",
                                           commands=("wc", ))
        await ws.approvals.grant(request.id, "session")
        assert await _line(ws, "wc -c /scratch/z") == (0, "0 /scratch/z\n", "")
        assert await _line(ws, "wc -l /scratch/z") == (0, "0 /scratch/z\n", "")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_is_consumed_through_a_fork():
    ws = _ask_ws()
    try:
        await ws.execute("touch /scratch/z")
        code, _, _ = await _line(ws, "rm /scratch/z")
        assert code == 126
        (request, ) = ws.approvals.list()
        await ws.approvals.grant(request.id)
        # execute(env=) runs the line in a fork of the session: the once
        # grant is read and consumed through the manager, so the fork
        # spends it for the session it forked from.
        forked = await ws.execute("rm /scratch/z", env={"X": "1"})
        assert forked.exit_code == 0
        code, _, err = await _line(ws, "rm /scratch/z")
        assert code == 126 and "requires approval" in err
    finally:
        await ws.close()


async def _host_allows_once(request: ApprovalRequest) -> str:
    return "allow_once"


async def _host_denies(request: ApprovalRequest) -> str:
    return "deny"


@pytest.mark.asyncio
async def test_a_blocking_approver_answers_inside_the_line():
    ws = _ask_ws(approver=CallbackApprover(_host_allows_once))
    try:
        await ws.execute("touch /scratch/z")
        assert (await _line(ws, "rm /scratch/z"))[0] == 0
        assert ws.approvals.list() == ()
    finally:
        await ws.close()
    ws = _ask_ws(approver=CallbackApprover(_host_denies))
    try:
        await ws.execute("touch /scratch/z")
        assert await _line(
            ws, "rm /scratch/z") == (126, "", "rm: policy denied: sign-off\n")
        assert (await _line(ws, "cat /scratch/z"))[0] == 0
    finally:
        await ws.close()
