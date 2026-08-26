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

from mirage.commands.cli.builtin.gh.pull import _check, checks_cmd
from mirage.commands.cli.types import CLIInvocation
from mirage.core.github.config import GhConfig

CONFIG = GhConfig(token="t")


def _inv(texts=(), flags=None) -> CLIInvocation:
    return CLIInvocation(CONFIG,
                         argv=(),
                         texts=tuple(texts),
                         flags=flags or {},
                         stdin=None,
                         doors=None)


@pytest.mark.parametrize("conclusion,bucket", [
    ("success", "pass"),
    ("neutral", "skipping"),
    ("skipped", "skipping"),
    ("failure", "fail"),
    ("error", "fail"),
    ("timed_out", "fail"),
    ("action_required", "fail"),
    ("cancelled", "cancel"),
    ("stale", "pending"),
])
def test_conclusions_bucket_the_way_gh_buckets_them(conclusion, bucket):
    assert _check({"name": "t", "conclusion": conclusion})["bucket"] == bucket


@pytest.mark.parametrize(
    "status", ["queued", "in_progress", "pending", "requested", "waiting"])
def test_an_unfinished_run_is_pending(status):
    assert _check({"name": "t", "status": status})["bucket"] == "pending"


def test_an_unknown_state_is_pending_rather_than_failed():
    assert _check({"name": "t", "conclusion": "invented"})["bucket"] \
        == "pending"


@pytest.mark.asyncio
async def test_a_cancelled_check_does_not_fail_the_command(monkeypatch):

    async def checks(config, ref, number):
        return [{"name": "t", "conclusion": "cancelled"}]

    monkeypatch.setitem(checks_cmd.__globals__, "pull_checks", checks)

    _, io = await checks_cmd(_inv(texts=["5"], flags={"repo": "o/r"}))

    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_a_failing_check_still_exits_one(monkeypatch):

    async def checks(config, ref, number):
        return [{"name": "t", "conclusion": "failure"}]

    monkeypatch.setitem(checks_cmd.__globals__, "pull_checks", checks)

    _, io = await checks_cmd(_inv(texts=["5"], flags={"repo": "o/r"}))

    assert io.exit_code == 1
