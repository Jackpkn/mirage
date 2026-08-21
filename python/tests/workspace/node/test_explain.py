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
import pytest_asyncio

from mirage import Workspace
from mirage.policy.match import Outcome
from mirage.policy.types import Scope
from mirage.resource.ram import RAMResource
from mirage.types import MountMode

ROLE = {
    "commands": {
        "allow": ["ls", "cat", "git", "rm", "mkdir"],
        "deny": [{
            "reason": "production data is protected",
            "commands": {
                "rm": ["/data/prod/*"]
            }
        }],
        "ask": [{
            "reason": "pushes need sign-off",
            "commands": ["git push"]
        }, {
            "reason": "secrets need sign-off",
            "commands": {
                "cat": ["/data/secret.txt"]
            }
        }],
    },
}


@pytest_asyncio.fixture()
async def ws():
    workspace = Workspace({"/data/": RAMResource()},
                          mode=MountMode.WRITE,
                          profiles={"r": ROLE})
    await workspace.execute("mkdir -p /data/prod")
    await workspace.ops.write("/data/prod/x.txt", b"x\n")
    await workspace.ops.write("/data/a.txt", b"a\n")
    await workspace.ops.write("/data/secret.txt", b"s\n")
    workspace.create_session("s", profile="r")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_explain_answers_each_verb_and_names_the_rule(ws):
    allowed, = await ws.explain("cat /data/a.txt", "s")
    assert allowed.outcome is Outcome.ALLOW
    assert allowed.exit_code == 0
    assert allowed.stderr == ""
    assert allowed.rule is None

    denied, = await ws.explain("rm /data/prod/x.txt", "s")
    assert denied.outcome is Outcome.DENY
    assert denied.rule is not None
    assert denied.reason == "production data is protected"
    assert denied.source == "top"
    assert denied.matched_path == "/data/prod/x.txt"

    asked, = await ws.explain("git push origin main", "s")
    assert asked.outcome is Outcome.ASK
    assert asked.reason == "pushes need sign-off"


@pytest.mark.asyncio
async def test_a_word_the_session_cannot_see_is_deny_at_127(ws):
    # Both refusals the allow list produces are DENY with no rule; the
    # exit code is what separates a head word the session cannot see
    # from a line no allow entry covers.
    missing, = await ws.explain("gerp x", "s")
    assert missing.outcome is Outcome.DENY
    assert missing.rule is None
    assert missing.source == "commands.allow"
    assert missing.exit_code == 127
    assert missing.stderr == "gerp: command not found\n"


@pytest.mark.asyncio
async def test_explain_reads_every_command_of_a_line(ws):
    first, second = await ws.explain(
        "cat /data/a.txt && rm /data/prod/x.txt", "s")
    assert (first.command, first.outcome) == ("cat", Outcome.ALLOW)
    assert (second.command, second.outcome) == ("rm", Outcome.DENY)


@pytest.mark.asyncio
async def test_explain_says_exactly_what_the_run_would_say(ws):
    for line in ("rm /data/prod/x.txt", "git push origin main", "gerp x"):
        ran = await ws.execute(line, session_id="s")
        said, = await ws.explain(line, "s")
        assert said.exit_code == ran.exit_code
        assert said.stderr == (ran.stderr or b"").decode()


@pytest.mark.asyncio
async def test_explain_spends_nothing(ws):
    # A dry run of an ask must not put the question to anyone, or the
    # host would field requests for lines nobody typed, and must not
    # spend a grant, or explaining a line would use up its answer.
    for _ in range(3):
        await ws.explain("git push origin main", "s")
    assert ws.decisions.pending() == ()
    assert ws.get_session("s").decisions == ()
    await ws.explain("rm /data/prod/x.txt", "s")
    assert sorted(await ws.ops.readdir("/data")) == [
        "/data/a.txt", "/data/prod", "/data/secret.txt"
    ]


@pytest.mark.asyncio
async def test_a_denied_command_stops_the_whole_line(ws):
    # The agent composed the line as one intent, so a rule refusing
    # part of it refuses the intent: judging each command as the
    # dispatcher reached it deleted the first file and refused the
    # second.
    ran = await ws.execute("rm /data/a.txt && rm /data/prod/x.txt",
                           session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == (
        b"rm: /data/prod/x.txt: production data is protected\n")
    assert "/data/a.txt" in await ws.ops.readdir("/data")


@pytest.mark.asyncio
async def test_a_word_the_session_cannot_see_leaves_the_line_alone(ws):
    # A head word the session cannot see is a routing miss, not a
    # verdict, so it stays bash: the stage fails and the rest of the
    # line does what bash does. A typo must not cost an agent the work
    # the line already did.
    ran = await ws.execute("rm /data/a.txt && gerp x", session_id="s")
    assert ran.exit_code == 127
    assert ran.stderr == b"gerp: command not found\n"
    assert "/data/a.txt" not in await ws.ops.readdir("/data")


@pytest.mark.asyncio
async def test_an_asked_command_holds_the_line_until_it_is_answered(ws):
    line = "rm /data/a.txt && cat /data/secret.txt"
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 126
    assert "/data/a.txt" in await ws.ops.readdir("/data")
    # Exactly one request, from the one pass that judged the line.
    pending, = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
    # The whole line replays, which is only sound because none of it
    # ran the first time, and the grant is spent exactly once even
    # though two passes now read it.
    again = await ws.execute(line, session_id="s")
    assert again.exit_code == 0
    assert "/data/a.txt" not in await ws.ops.readdir("/data")
    assert ws.decisions.pending() == ()


@pytest.mark.asyncio
async def test_a_cd_earlier_in_the_line_moves_what_later_rules_read(ws):
    # The line is judged before it runs, so the pass has to walk a
    # literal `cd` itself or a rule about /data/prod would answer about
    # whatever directory the session happened to be in.
    ran = await ws.execute("cd /data/prod && rm x.txt", session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == b"rm: x.txt: production data is protected\n"


@pytest.mark.asyncio
async def test_explain_reads_a_cd_the_same_way_the_run_does(ws):
    # explain and the pass that decides the line share one walk, so a
    # host asking about a line and the agent typing it cannot be told
    # different things about where the line ends up.
    line = "cd /data/prod && rm x.txt"
    _, removed = await ws.explain(line, "s")
    assert removed.outcome is Outcome.DENY
    ran = await ws.execute(line, session_id="s")
    assert removed.exit_code == ran.exit_code
    assert removed.stderr == (ran.stderr or b"").decode()


@pytest.mark.asyncio
async def test_the_hold_reaches_only_as_far_as_the_text_does(ws):
    # The pass reads the text of a line and the gate reads its values,
    # so a path the runtime computes is invisible here and the hold
    # lapses. The ask still fires, at the gate, once the earlier
    # commands have run. Pinned rather than only documented, because
    # the cost lands on the replay: approving this re-runs a line whose
    # first half is already done.
    ran = await ws.execute("S=/data/secret.txt; rm /data/a.txt && cat $S",
                           session_id="s")
    assert ran.exit_code == 126
    assert "/data/a.txt" not in await ws.ops.readdir("/data")
    assert len(ws.decisions.pending()) == 1


@pytest.mark.asyncio
async def test_a_cd_in_a_subshell_does_not_move_later_commands(ws):
    # bash restores the cwd when the subshell exits, so carrying the cd
    # past it refused a line that was never going to touch /data/prod.
    ran = await ws.execute("(cd /data/prod && ls) && rm x.txt",
                           session_id="s")
    assert ran.exit_code == 1
    assert b"production data is protected" not in (ran.stderr or b"")
    assert "/data/prod/x.txt" in await ws.ops.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_grant_the_session_holds_shows_the_line_running(ws):
    ran = await ws.execute("git push origin main", session_id="s")
    assert ran.exit_code == 126
    pending, = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.SESSION)
    # The document still says ask, because that is what it says; the
    # exit code says 0, because that is what the line would now do.
    asked, = await ws.explain("git push origin main", "s")
    assert asked.outcome is Outcome.ASK
    assert asked.exit_code == 0
    assert asked.stderr == ""
