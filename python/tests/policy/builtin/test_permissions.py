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

from mirage.policy import (Ask, CommandContext, CommandRule, CommandsSpec,
                           Deny, DenyScope, OpsContext, PermissionsPolicy,
                           Policies)
from mirage.types import PathSpec


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


class _Sessions:
    """A SessionCommandsQuery: bound tiers for every id, plus one
    session's own tier."""

    def __init__(self, bound: tuple[CommandsSpec, ...],
                 own: dict[str, CommandsSpec]) -> None:
        self.bound = bound
        self.own = own

    def commands_of(self, session_id: str) -> tuple[CommandsSpec, ...]:
        spec = self.own.get(session_id)
        return self.bound if spec is None else (*self.bound, spec)


def _path(virtual: str, raw: str = "") -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual,
                    resolved=True,
                    raw_path=raw)


def _ctx(command: str,
         *args: str,
         paths: tuple[PathSpec, ...] = (),
         cwd: str = "/",
         session_id: str = "s",
         program: tuple[str, ...] = (),
         tool: bool = True) -> CommandContext:
    return CommandContext(command=command,
                          paths=paths,
                          argv=tuple(args),
                          cwd=cwd,
                          registry=_Registry(),
                          session_id=session_id,
                          tokens=(command, *args),
                          program=program or (command, ),
                          tool=tool)


BOUND = (
    CommandsSpec(deny=(CommandRule(reason="history is read-only here",
                                   commands=("git push", ),
                                   mount="/repo"), )),
    CommandsSpec(allow=("ls", "cat", "rm", "git", "python3"),
                 deny=(CommandRule(reason="no deletes in the repo",
                                   commands=("rm", ),
                                   paths=("/repo/*", )),
                       CommandRule(reason="frozen",
                                   paths=("/repo/locked/*", ))),
                 ask=(CommandRule(reason="sign-off",
                                  commands=("git push", )), )),
)
REVIEWER = CommandsSpec(allow=("ls", "cat", "git log", "git status"))


def _policy() -> PermissionsPolicy:
    return PermissionsPolicy(_Sessions(BOUND, {"rev": REVIEWER}))


@pytest.mark.asyncio
async def test_no_tiers_means_no_opinion():
    policy = PermissionsPolicy(_Sessions((), {}))
    assert await policy.pre_command(_ctx("rm", "-rf", "/")) is None
    assert await policy.pre_ops(
        OpsContext(op="unlink", path=_path("/x"), write=True,
                   prefix="/")) is None


@pytest.mark.asyncio
async def test_allow_arm_refuses_a_visible_head_whose_line_no_tier_covers():
    policy = _policy()
    # Every tier with a list covers `ls -la` and `git log`.
    assert await policy.pre_command(_ctx("ls", "-la",
                                         session_id="rev")) is None
    assert await policy.pre_command(
        _ctx("git", "log", "-1", session_id="rev",
             program=("git", "log"))) is None
    # `git` is visible in the reviewer session (some git lines are
    # allowed) but `git push` matches nothing there: a whole-command
    # refusal naming the program, not "command not found".
    deny = await policy.pre_command(
        _ctx("git", "push", session_id="rev", program=("git", "push")))
    assert deny == Deny("git push is not allowed")
    # A word that is not a tool is never refused by the allow arm.
    assert await policy.pre_command(
        _ctx("cd", "/x", session_id="rev", tool=False)) is None
    # The default session runs under the bound tiers only.
    assert await policy.pre_command(_ctx("python3", "-c", "1")) is None


@pytest.mark.asyncio
async def test_deny_arm_speaks_in_tier_order_and_by_scope():
    policy = _policy()
    # Whole-command rule: reason only, the door renders `git: policy
    # denied: ...` at 126. The mount tier speaks first when it applies
    # (cwd under /repo), the workspace tier otherwise.
    assert await policy.pre_command(
        _ctx("git", "push", cwd="/repo/sub",
             program=("git", "push"))) == Deny("history is read-only here")
    # Off the mount, the same line falls through to the workspace tier's
    # ask rule: the deny arm ran first and had no opinion.
    assert await policy.pre_command(
        _ctx("git", "push", cwd="/scratch",
             program=("git", "push"))) == Ask("sign-off", BOUND[1].ask[0])
    # Operand-scoped rule: the operand as typed, in the GNU voice.
    assert await policy.pre_command(
        _ctx("rm", "x", paths=(_path("/repo/x", raw="x"), ),
             cwd="/repo")) == Deny("x: no deletes in the repo",
                                   DenyScope.OPERAND)
    assert await policy.pre_command(
        _ctx("rm", "/scratch/x", paths=(_path("/scratch/x"), ))) is None
    # A pure path rule refuses any command that names the path.
    assert await policy.pre_command(
        _ctx("cat", "/repo/locked/a", paths=(_path("/repo/locked/a"), ))
    ) == Deny("/repo/locked/a: frozen", DenyScope.OPERAND)


@pytest.mark.asyncio
async def test_ask_arm_speaks_after_deny_in_tier_order():
    policy = _policy()
    ask_rule = BOUND[1].ask[0]
    # A line an ask rule covers, refused by nothing: the Ask names the
    # rule so the door can key a session grant on it.
    assert await policy.pre_command(
        _ctx("git",
             "push",
             "origin",
             "main",
             cwd="/scratch",
             program=("git", "push"))) == Ask("sign-off", ask_rule)
    # The deny arm runs first: on the mount the same line is refused,
    # and a grant could never re-open it because no Ask is raised.
    assert await policy.pre_command(
        _ctx("git", "push", cwd="/repo",
             program=("git", "push"))) == Deny("history is read-only here")
    # A session's own tier can add ask rules; the bound tiers ask first.
    own = CommandsSpec(
        ask=(CommandRule(reason="rm needs a nod", commands=("rm", )), ))
    scoped = PermissionsPolicy(_Sessions(BOUND, {"s": own}))
    assert await scoped.pre_command(
        _ctx("rm", "/scratch/x",
             paths=(_path("/scratch/x"), ))) == Ask("rm needs a nod",
                                                    own.ask[0])
    # An operand-scoped ask rule asks only when the line names the path.
    shared = CommandsSpec(ask=(CommandRule(
        reason="shared", commands=("rm", ), paths=("/repo/shared/*", )), ))
    door = PermissionsPolicy(_Sessions((), {"s": shared}))
    assert await door.pre_command(
        _ctx("rm", "/repo/shared/a", paths=(_path("/repo/shared/a"), ))
    ) == Ask("shared", shared.ask[0])
    assert await door.pre_command(
        _ctx("rm", "/repo/b", paths=(_path("/repo/b"), ))) is None


@pytest.mark.asyncio
async def test_pre_ops_holds_the_pure_path_rules_of_every_tier():
    policy = _policy()
    locked = OpsContext(op="write",
                        path=_path("/repo/locked/a"),
                        write=True,
                        prefix="/repo/",
                        session_id="s")
    assert await policy.pre_ops(locked) == Deny("frozen")
    # Command-scoped rules do not reach the op door: an op does not
    # know which command issued it.
    assert await policy.pre_ops(
        OpsContext(op="unlink",
                   path=_path("/repo/x"),
                   write=True,
                   prefix="/repo/",
                   session_id="s")) is None
    # An unbound door (empty id) still runs under the bound tiers.
    unbound = OpsContext(op="write",
                         path=_path("/repo/locked/a"),
                         write=True,
                         prefix="/repo/")
    assert await policy.pre_ops(unbound) == Deny("frozen")


@pytest.mark.asyncio
async def test_seeded_in_a_policies_chain_after_the_builtins():
    policies = Policies([_policy()])
    deny = await policies.pre_command(
        _ctx("git", "push", cwd="/repo", program=("git", "push")))
    assert deny == Deny("history is read-only here")
    assert policies.wants("pre_ops")
