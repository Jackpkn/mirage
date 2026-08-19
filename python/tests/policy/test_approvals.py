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

from mirage.policy import (ApprovalRequest, Approvals, Ask, CallbackApprover,
                           CommandContext, CommandRule, Deny, Grant, Pending,
                           ask_rule, request_id)
from mirage.types import PathSpec

RULE = CommandRule(reason="sign-off", commands=("git push", ))
ASK = Ask("sign-off", RULE)


class Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


class Sessions:
    """A SessionGrantsQuery over a dict, counting flushes."""

    def __init__(self) -> None:
        self.grants: dict[str, tuple[Grant, ...]] = {}
        self.flushes = 0

    def grants_of(self, session_id: str) -> tuple[Grant, ...]:
        return self.grants.get(session_id, ())

    def set_grants(self, session_id: str, grants: tuple[Grant, ...]) -> None:
        self.grants[session_id] = grants

    async def flush(self) -> None:
        self.flushes += 1


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual,
                    raw_path=virtual,
                    resolved=True)


def _ctx(
    words: tuple[str, ...] = ("git", "push"),
    cwd: str = "/repo",
    session_id: str = "s",
    program: tuple[str, ...] = ("git", "push"),
    paths: tuple[PathSpec, ...] = ()
) -> CommandContext:
    return CommandContext(command=words[0],
                          paths=paths,
                          argv=words[1:],
                          cwd=cwd,
                          registry=Registry(),
                          session_id=session_id,
                          tokens=words,
                          program=program)


def test_ask_rule_is_the_documents_or_the_program_that_asked():
    assert ask_rule(_ctx(), ASK) is RULE
    coded = ask_rule(
        _ctx(("git", "-C", "/r", "push"), program=("git", "push")),
        Ask("looks risky"))
    assert coded == CommandRule(reason="looks risky", commands=("git push", ))
    bare = ask_rule(_ctx(("rm", "-rf", "x"), program=()), Ask("risky"))
    assert bare == CommandRule(reason="risky", commands=("rm", ))


@pytest.mark.asyncio
async def test_record_flow_once():
    sessions = Sessions()
    door = Approvals(sessions)
    ctx = _ctx(paths=(_path("/repo"), ))
    # Asked: pending, quoting an id the host can act on; the request
    # carries what was asked.
    pending = await door.resolve(ctx, ASK)
    assert pending == Pending(request_id("s", "/repo", ("git", "push")),
                              "sign-off")
    (request, ) = door.list()
    assert request == ApprovalRequest(id=pending.id,
                                      session_id="s",
                                      agent_id="",
                                      command="git",
                                      argv=("push", ),
                                      cwd="/repo",
                                      paths=("/repo", ),
                                      reason="sign-off",
                                      rule=RULE)
    # A retry asks the same question: no second entry, same id.
    assert await door.resolve(ctx, ASK) == pending
    assert len(door.list()) == 1
    # Granted once: the exact line passes one time, durably, and is
    # then asked again.
    await door.grant(pending.id)
    assert door.list() == ()
    assert sessions.flushes == 1
    assert sessions.grants["s"] == (Grant("allow_once", RULE, ("git", "push"),
                                          "/repo"), )
    assert await door.resolve(ctx, ASK) is None
    assert sessions.grants["s"] == ()
    assert await door.resolve(ctx, ASK) == pending
    # A once grant is for the exact words and cwd: a different line
    # under the same rule is asked, and so is the same line elsewhere.
    await door.grant(pending.id)
    assert isinstance(
        await door.resolve(_ctx(("git", "push", "--force")), ASK), Pending)
    assert isinstance(await door.resolve(_ctx(cwd="/scratch"), ASK), Pending)
    assert await door.resolve(ctx, ASK) is None


@pytest.mark.asyncio
async def test_record_flow_session_and_deny():
    sessions = Sessions()
    door = Approvals(sessions)
    ctx = _ctx()
    pending = await door.resolve(ctx, ASK)
    assert isinstance(pending, Pending)
    # Granted for the session: every line the rule covers passes, the
    # grant stays; another session is not covered.
    await door.grant(pending.id, "session")
    assert await door.resolve(ctx, ASK) is None
    assert await door.resolve(_ctx(("git", "push", "--force")), ASK) is None
    assert await door.resolve(_ctx(cwd="/scratch"), ASK) is None
    assert sessions.grants["s"] == (Grant("allow_session", RULE,
                                          ("git", "push"), "/repo"), )
    other = await door.resolve(_ctx(session_id="t"), ASK)
    assert isinstance(other, Pending)
    # A different rule is a different question even for the same line.
    force = Ask(
        "force needs a second pair of eyes",
        CommandRule(reason="force needs a second pair of eyes",
                    commands=("git push --force", )))
    assert isinstance(
        await door.resolve(_ctx(("git", "push", "--force")), force), Pending)
    # Denied: the retry of the exact line is refused once, in the ask's
    # voice, then the question is open again.
    await door.deny(other.id)
    assert await door.resolve(_ctx(session_id="t"), ASK) == Deny("sign-off")
    assert isinstance(await door.resolve(_ctx(session_id="t"), ASK), Pending)


@pytest.mark.asyncio
async def test_unknown_or_answered_ids_are_refused():
    door = Approvals(Sessions())
    with pytest.raises(KeyError):
        await door.grant("nothing")
    pending = await door.resolve(_ctx(), ASK)
    assert isinstance(pending, Pending)
    await door.deny(pending.id)
    with pytest.raises(KeyError):
        await door.deny(pending.id)
    # A blocking approver leaves nothing to grant.
    blocking = Approvals(Sessions(), CallbackApprover(_allow_once))
    assert blocking.list() == ()
    with pytest.raises(KeyError):
        await blocking.grant("x")


async def _allow_once(request: ApprovalRequest) -> str:
    return "allow_once"


async def _allow_session(request: ApprovalRequest) -> str:
    return "allow_session"


async def _deny(request: ApprovalRequest) -> str:
    return "deny"


@pytest.mark.asyncio
async def test_callback_flow_answers_inside_the_line():
    sessions = Sessions()
    once = Approvals(sessions, CallbackApprover(_allow_once))
    assert await once.resolve(_ctx(), ASK) is None
    assert sessions.grants == {}
    forever = Approvals(sessions, CallbackApprover(_allow_session))
    assert await forever.resolve(_ctx(), ASK) is None
    assert sessions.grants["s"] == (Grant("allow_session", RULE,
                                          ("git", "push"), "/repo"), )
    no = Approvals(Sessions(), CallbackApprover(_deny))
    assert await no.resolve(_ctx(), ASK) == Deny("sign-off")


@pytest.mark.asyncio
async def test_a_coded_ask_keys_the_session_grant_on_the_program():
    sessions = Sessions()
    door = Approvals(sessions, CallbackApprover(_allow_session))
    coded = Ask("looks risky")
    assert await door.resolve(_ctx(("rm", "-rf", "x"), program=("rm", )),
                              coded) is None
    # The next rm line under the same coded ask is covered ...
    recorder = Approvals(sessions)
    assert await recorder.resolve(_ctx(("rm", "y"), program=("rm", )),
                                  coded) is None
    # ... a different program is not.
    assert isinstance(
        await recorder.resolve(_ctx(("mv", "a", "b"), program=("mv", )),
                               coded), Pending)


@pytest.mark.asyncio
async def test_without_sessions_grants_live_in_memory():
    door = Approvals(agent_of=_agent)
    pending = await door.resolve(_ctx(), ASK)
    assert isinstance(pending, Pending)
    assert door.list()[0].agent_id == "claude"
    await door.grant(pending.id, "session")
    assert await door.resolve(_ctx(), ASK) is None
    assert isinstance(await door.resolve(_ctx(session_id="t"), ASK), Pending)


def _agent() -> str:
    return "claude"
