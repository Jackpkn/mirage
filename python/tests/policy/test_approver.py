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

import pytest

from mirage.policy import (ApprovalRequest, CallbackApprover, CommandRule,
                           RecordApprover, request_id)

RULE = CommandRule(reason="sign-off", commands=("git push", ))


def _request(words: tuple[str, ...] = ("git", "push"),
             cwd: str = "/repo",
             session_id: str = "s") -> ApprovalRequest:
    return ApprovalRequest(id=request_id(session_id, cwd, words),
                           session_id=session_id,
                           agent_id="",
                           command=words[0],
                           argv=words[1:],
                           cwd=cwd,
                           paths=(),
                           reason="sign-off",
                           rule=RULE)


def test_request_id_is_a_digest_of_what_was_asked():
    same = request_id("s", "/repo", ("git", "push"))
    assert same == request_id("s", "/repo", ("git", "push"))
    # sha256("s\0/repo\0git\0push\0")[:12], the value the TypeScript
    # requestId computes for the same question (pinned in approver.test.ts).
    assert same == "22ce9edec956"
    # Any of session, cwd or a word changes the question.
    assert same != request_id("t", "/repo", ("git", "push"))
    assert same != request_id("s", "/scratch", ("git", "push"))
    assert same != request_id("s", "/repo", ("git", "pull"))
    # Words are delimited, so a boundary shift is not the same line.
    assert request_id("s", "/",
                      ("ab", "c")) != request_id("s", "/", ("a", "bc"))


@pytest.mark.asyncio
async def test_record_approver_records_and_answers_pending():
    approver = RecordApprover()
    first = _request()
    assert await approver.approve(first) is None
    assert approver.pending() == (first, )
    # A retry of the same line asks the same question: one entry, the
    # first request kept, oldest first.
    again = _request()
    assert await approver.approve(again) is None
    other = _request(("git", "push", "--force"))
    assert await approver.approve(other) is None
    assert approver.pending() == (first, other)
    assert approver.take(first.id) is first
    assert approver.pending() == (other, )
    with pytest.raises(KeyError):
        approver.take(first.id)


@pytest.mark.asyncio
async def test_callback_approver_returns_the_host_answer():
    seen: list[ApprovalRequest] = []

    async def host(request: ApprovalRequest) -> str:
        seen.append(request)
        return "allow_session"

    approver = CallbackApprover(host)
    request = _request()
    assert await approver.approve(request) == "allow_session"
    assert seen == [request]


@pytest.mark.asyncio
async def test_callback_approver_denies_on_timeout():

    async def slow(request: ApprovalRequest) -> str:
        await asyncio.sleep(10)
        return "allow_once"

    approver = CallbackApprover(slow, timeout=0.01)
    assert await approver.approve(_request()) == "deny"
