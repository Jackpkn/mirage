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

import dataclasses

import pytest

from mirage.policy.decisions import Decisions, ask_rule, covers, decision_id
from mirage.policy.match import Outcome
from mirage.policy.types import (Ask, CommandContext, CommandRule, Decision,
                                 Deny, Pending, Scope)

RULE = CommandRule(reason="sign-off", commands=("git push", ))


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _ctx(command: str = "git",
         argv: tuple[str, ...] = ("push", ),
         cwd: str = "/repo",
         session_id: str = "s") -> CommandContext:
    return CommandContext(command=command,
                          paths=(),
                          operands=(),
                          argv=argv,
                          cwd=cwd,
                          session_id=session_id,
                          registry=_Registry(),
                          tokens=(command, *argv))


def _record(**over: object) -> Decision:
    base = Decision(id="d1",
                    session_id="s",
                    agent_id="",
                    command="git",
                    argv=("push", ),
                    cwd="/repo",
                    paths=(),
                    reason="sign-off",
                    rule=RULE)
    return dataclasses.replace(base, **over)  # type: ignore[arg-type]


def test_decision_id_is_stable_for_the_same_line_and_session():
    same = decision_id("s", "/repo", ("git", "push"))
    assert same == decision_id("s", "/repo", ("git", "push"))
    assert same != decision_id("other", "/repo", ("git", "push"))
    assert same != decision_id("s", "/elsewhere", ("git", "push"))
    assert len(same) == 12


def test_ask_rule_synthesizes_one_over_the_program_for_a_coded_ask():
    assert ask_rule(_ctx(), Ask("sign-off", rule=RULE)) is RULE
    coded = ask_rule(_ctx(), Ask("sign-off"))
    assert coded.commands == ("git", )
    assert coded.reason == "sign-off"


def test_covers_reads_scope_and_never_answers_a_waiting_record():
    argv = ("git", "push")
    assert not covers(_record(), RULE, argv, "/repo")
    once = _record(outcome=Outcome.ALLOW, scope=Scope.ONCE)
    assert covers(once, RULE, argv, "/repo")
    # A ONCE answer is for the exact line, so a different line or a
    # different directory is not it.
    assert not covers(once, RULE, ("git", "push", "-f"), "/repo")
    assert not covers(once, RULE, argv, "/elsewhere")
    # A SESSION answer covers any line the same rule asks about.
    forever = _record(outcome=Outcome.ALLOW, scope=Scope.SESSION)
    assert covers(forever, RULE, ("git", "push", "-f"), "/elsewhere")
    # An answer never answers a rule it was not given for: a persisted
    # record reopened under an edited profile must not speak for the
    # new rule.
    other = CommandRule(reason="different", commands=("git push", ))
    assert not covers(forever, other, argv, "/repo")


@pytest.mark.asyncio
async def test_a_question_is_recorded_once_and_answered_once():
    ledger = Decisions()
    ctx, ask = _ctx(), Ask("sign-off", rule=RULE)
    first = await ledger.resolve(ctx, ask)
    assert isinstance(first, Pending)
    # A retry reuses the record rather than filing a second one, so the
    # agent keeps quoting one id.
    again = await ledger.resolve(ctx, ask)
    assert isinstance(again, Pending) and again.id == first.id
    assert len(ledger.pending()) == 1
    await ledger.answer(first.id, Outcome.ALLOW, Scope.ONCE)
    assert ledger.pending() == ()
    assert len(ledger.list()) == 1
    assert await ledger.resolve(ctx, ask) is None
    # ONCE is consumed by the line it answered, so the next asks again.
    assert isinstance(await ledger.resolve(ctx, ask), Pending)


@pytest.mark.asyncio
async def test_a_session_answer_is_not_consumed_and_a_deny_refuses():
    ledger = Decisions()
    ctx, ask = _ctx(), Ask("sign-off", rule=RULE)
    pending = await ledger.resolve(ctx, ask)
    assert isinstance(pending, Pending)
    await ledger.answer(pending.id, Outcome.ALLOW, Scope.SESSION)
    for _ in range(3):
        assert await ledger.resolve(ctx, ask) is None

    refused = Decisions()
    asked = await refused.resolve(ctx, ask)
    assert isinstance(asked, Pending)
    await refused.answer(asked.id, Outcome.DENY, note="not this one")
    action = await refused.resolve(ctx, ask)
    assert isinstance(action, Deny) and action.reason == "sign-off"


@pytest.mark.asyncio
async def test_held_reads_without_recording_or_spending():
    ledger = Decisions()
    ctx, ask = _ctx(), Ask("sign-off", rule=RULE)
    # Nothing is on file, so held reports waiting and files nothing.
    for _ in range(3):
        assert isinstance(ledger.held(ctx, ask), Pending)
    assert ledger.list() == ()
    pending = await ledger.resolve(ctx, ask)
    assert isinstance(pending, Pending)
    await ledger.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
    # Reading it does not spend it: the run that follows still passes.
    assert ledger.held(ctx, ask) is None
    assert ledger.held(ctx, ask) is None
    assert await ledger.resolve(ctx, ask) is None


@pytest.mark.asyncio
async def test_answering_rejects_ask_and_an_unknown_id():
    ledger = Decisions()
    pending = await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE))
    assert isinstance(pending, Pending)
    with pytest.raises(ValueError):
        await ledger.answer(pending.id, Outcome.ASK)
    with pytest.raises(KeyError):
        await ledger.answer("nosuchid", Outcome.ALLOW)
    # Answering twice is answering an id nothing is waiting on.
    await ledger.answer(pending.id, Outcome.ALLOW)
    with pytest.raises(KeyError):
        await ledger.answer(pending.id, Outcome.DENY)


@pytest.mark.asyncio
async def test_a_host_that_answers_inside_the_line_leaves_nothing_waiting():

    async def allow(record: Decision) -> Decision:
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.SESSION)

    ledger = Decisions(on_ask=allow)
    assert await ledger.resolve(_ctx(), Ask("sign-off", rule=RULE)) is None
    assert ledger.pending() == ()
    assert len(ledger.list()) == 1

    async def undecided(record: Decision) -> Decision | None:
        return None

    waiting = Decisions(on_ask=undecided)
    action = await waiting.resolve(_ctx(), Ask("sign-off", rule=RULE))
    assert isinstance(action, Pending)
    assert len(waiting.pending()) == 1


@pytest.mark.asyncio
async def test_records_are_listed_per_session_and_across_them():
    ledger = Decisions()
    ask = Ask("sign-off", rule=RULE)
    await ledger.resolve(_ctx(session_id="a"), ask)
    await ledger.resolve(_ctx(session_id="b"), ask)
    assert len(ledger.list()) == 2
    assert len(ledger.list("a")) == 1
    assert ledger.list("a")[0].session_id == "a"
    assert ledger.list("nobody") == ()
