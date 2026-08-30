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
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from mirage import Action, CommandContext, Deny, MountMode, Policy, Workspace
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.io import IOResult
from mirage.policy import Ask
from mirage.policy.match import Outcome
from mirage.policy.types import Decision, Scope
from mirage.resource.ram import RAMResource
from mirage.secrets import registry
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.shell.parse import parse
from mirage.shell.variable import ManagedRef, ShellVar, VarAttr
from mirage.types import HiddenVars

FetchFn = Callable[[Any, str], Coroutine[Any, Any, ResolvedSecret]]


class FakeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})


def counting_source(fields: dict[str, str]) -> tuple[list[str], FetchFn]:
    calls: list[str] = []

    async def fetch(config: FakeConfig, ref: str) -> ResolvedSecret:
        calls.append(ref)
        return ResolvedSecret(fields=dict(fields))

    return calls, fetch


def dead_source() -> FetchFn:

    async def fetch(config: FakeConfig, ref: str) -> ResolvedSecret:
        raise RuntimeError("connection refused")

    return fetch


def _ws(env, **kw) -> Workspace:
    return Workspace({"/": RAMResource()},
                     mode=kw.pop("mode", MountMode.WRITE),
                     env=env,
                     **kw)


@pytest.mark.asyncio
async def test_lazy_fetches_only_when_referenced_and_only_once():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("echo hi")).exit_code == 0
        assert calls == []
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_whole_env_command_fetches_an_unspelled_name():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("ls /")).exit_code == 0
        assert calls == []
        io = await ws.execute("env")
        assert "TOKEN=t0" in (await io.stdout_str())
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_eager_joins_every_line_a_lazy_sibling_waits():
    calls, fetch = counting_source({"E": "ev", "L": "lv"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({
        "E": {
            "from": "fake",
            "ref": "re",
            "fetch": "eager"
        },
        "L": {
            "from": "fake",
            "ref": "rl"
        },
    })
    try:
        assert (await ws.execute("echo hi")).exit_code == 0
        assert calls == ["re"]
        session = ws.get_session(ws.default_session_id)
        assert session.vars["E"].value == "ev"
        assert session.vars["L"].value is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_two_names_one_secret_is_one_fetch():
    calls, fetch = counting_source({"user": "u", "pass": "p"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({
        "DB_USER": {
            "from": "fake",
            "ref": "db",
            "key": "user"
        },
        "DB_PASS": {
            "from": "fake",
            "ref": "db",
            "key": "pass"
        },
    })
    try:
        io = await ws.execute("echo $DB_USER:$DB_PASS")
        assert (await io.stdout_str()) == "u:p\n"
        assert calls == ["db"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_key_defaults_to_the_variable_name():
    calls, fetch = counting_source({"API": "v"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"API": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("echo $API")
        assert (await io.stdout_str()) == "v\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_missing_key_names_both_sides():
    calls, fetch = counting_source({"a": "1", "b": "2"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"T": {"from": "fake", "ref": "r", "key": "c"}})
    try:
        io = await ws.execute("echo $T")
        assert io.exit_code == 1
        err = io.stderr.decode()
        assert "T" in err and "'c'" in err and "a, b" in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_per_session_env_is_that_sessions_alone():
    calls, fetch = counting_source({"S": "sv"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws(None)
    try:
        ws._session_mgr.create("s2", env={"S": {"from": "fake", "ref": "r"}})
        io = await ws.execute("echo $S", session_id="s2")
        assert (await io.stdout_str()) == "sv\n"
        assert calls == ["r"]
        assert "S" not in ws.get_session(ws.default_session_id).vars
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guest_runtime_reads_the_fetched_value():
    calls, fetch = counting_source({"GITHUB_TOKEN": "gt"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"GITHUB_TOKEN": {
        "from": "fake",
        "ref": "r"
    }},
             mode=MountMode.EXEC)
    try:
        io = await ws.execute(
            "python3 -c 'import os; print(os.environ[\"GITHUB_TOKEN\"])'")
        assert io.exit_code == 0
        assert (await io.stdout_str()) == "gt\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_readonly_preset_refuses_with_bash_wording():
    ws = _ws({"EDITOR": {"value": "vi", "readonly": True}})
    try:
        io = await ws.execute("EDITOR=x")
        assert io.exit_code == 1
        assert io.stderr == b"bash: EDITOR: readonly variable\n"
        io = await ws.execute("unset EDITOR")
        assert io.exit_code == 1
        assert io.stderr == (b"bash: unset: EDITOR: cannot unset: "
                             b"readonly variable\n")
        io = await ws.execute("echo $EDITOR")
        assert (await io.stdout_str()) == "vi\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_export_p_renders_an_unfetched_managed_name_unset():
    # Written straight into the session (no env block), so the fill
    # pass is off and the renderer meets the third state itself.
    ws = _ws(None)
    try:
        session = ws.get_session(ws.default_session_id)
        session.vars["T"] = ShellVar(None,
                                     frozenset({VarAttr.EXPORT}),
                                     managed=ManagedRef(
                                         "fake", "r", "T", False))
        io = await ws.execute("export -p")
        assert "declare -x T\n" in (await io.stdout_str())
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cmdsub_fetches_through_the_inner_fill():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("x=$(echo $TOKEN); echo $x")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_subshell_export_detaches_only_the_fork():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("(export TOKEN=y; echo $TOKEN)")
        assert (await io.stdout_str()) == "y\n"
        parent = ws.get_session(ws.default_session_id).vars["TOKEN"]
        assert parent.managed is not None
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "t0\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_write_then_read_detaches_and_serializes_the_value():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("export TOKEN=mine")).exit_code == 0
        after_write = len(calls)
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "mine\n"
        assert len(calls) == after_write
        d = ws.get_session(ws.default_session_id).to_dict()
        assert d["env"]["TOKEN"] == "mine"
        assert "managed" not in d
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_dead_source_fails_only_the_command_that_needs_it():
    register_secrets("fake", FakeConfig, dead_source())
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("echo $TOKEN")
        assert io.exit_code == 1
        # The source's own words stay host-side: the agent learns the
        # variable and the source name, never the exception text.
        assert io.stderr == b"TOKEN: cannot fetch from fake\n"
        assert (await ws.execute("ls /")).exit_code == 0
    finally:
        await ws.close()


def test_an_unknown_source_fails_at_construction():
    with pytest.raises(SecretsError, match="unknown secrets source"):
        _ws({"T": {"from": "nope", "ref": "r"}})


@pytest.mark.asyncio
async def test_mutating_export_detaches_without_fetching():
    register_secrets("fake", FakeConfig, dead_source())
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("export TOKEN=local")
        assert io.exit_code == 0
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "local\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mutating_forms_do_not_render_the_environment():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        for line in ("set -u", "set +u", "declare -x OTHER=1",
                     "export OTHER=2", "printenv PATH"):
            await ws.execute(line)
        assert calls == []
        io = await ws.execute("declare -p TOKEN")
        assert "t0" in (await io.stdout_str())
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_printenv_of_the_name_fetches_it():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("printenv TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_hidden_managed_name_never_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r", "fetch": "eager"}})
    try:
        session = ws.get_session(ws.default_session_id)
        session.hidden_vars = HiddenVars(names=("TOKEN", ))
        io = await ws.execute("env")
        assert io.exit_code == 0
        assert "TOKEN" not in (await io.stdout_str())
        io = await ws.execute("echo [$TOKEN]")
        assert (await io.stdout_str()) == "[]\n"
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stored_function_body_fills_across_lines():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute('f() { echo "t:$TOKEN"; }')).exit_code == 0
        assert calls == []
        io = await ws.execute("f")
        assert (await io.stdout_str()) == "t:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_function_calling_function_fills_transitively():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        await ws.execute('inner() { echo "i:$TOKEN"; }')
        await ws.execute("outer() { inner; }")
        assert calls == []
        io = await ws.execute("outer")
        assert (await io.stdout_str()) == "i:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_alias_body_fills_on_invocation():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("shopt -s expand_aliases")).exit_code == 0
        line = "alias show='echo \"a:$TOKEN\"'"
        assert (await ws.execute(line)).exit_code == 0
        assert calls == []
        io = await ws.execute("show")
        assert (await io.stdout_str()) == "a:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_alias_never_fetches_while_expansion_is_off():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        await ws.execute("alias show='echo $TOKEN'")
        io = await ws.execute("show")
        assert io.exit_code != 0
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_invocation_before_redefinition_fills_the_stored_body():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute('f() { echo "t:$TOKEN"; }')).exit_code == 0
        assert calls == []
        io = await ws.execute("f; f() { :; }")
        assert (await io.stdout_str()) == "t:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_every_same_line_redefinition_body_fills():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute('f() { :; }; f; f() { echo "e:$TOKEN"; }; f')
        assert (await io.stdout_str()) == "e:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_body_local_mask_never_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute(
            'f() { local TOKEN=shadow; echo "in:$TOKEN"; }; f')
        assert (await io.stdout_str()) == "in:shadow\n"
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_body_mask_leaves_the_line_read_fetching():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute('f() { local TOKEN=shadow; }; f; echo "g:$TOKEN"'
                              )
        assert (await io.stdout_str()) == "g:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_body_read_before_its_mask_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute(
            'f() { echo "pre:$TOKEN"; local TOKEN=shadow; }; f')
        assert (await io.stdout_str()) == "pre:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_body_assignment_masks_its_own_read():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute('f() { TOKEN=w; echo "in:$TOKEN"; }; f')
        assert (await io.stdout_str()) == "in:w\n"
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_body_mask_reading_the_standing_value_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute(
            'f() { local TOKEN=$TOKEN; echo "in:$TOKEN"; }; f')
        assert (await io.stdout_str()) == "in:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_top_level_declaration_masks():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("export TOKEN=local; printenv TOKEN")
        assert (await io.stdout_str()) == "local\n"
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_top_level_local_is_not_a_mask():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute('local TOKEN=x; echo "t:$TOKEN"')
        assert (await io.stdout_str()) == "t:t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_tilde_expansion_fetches_home():
    calls, fetch = counting_source({"HOME": "/hh"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"HOME": {"from": "fake", "ref": "h"}})
    try:
        io = await ws.execute("echo ~/logs")
        assert (await io.stdout_str()) == "/hh/logs\n"
        assert calls == ["h"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_bare_cd_fetches_home():
    calls, fetch = counting_source({"HOME": "/d"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"HOME": {"from": "fake", "ref": "h"}})
    try:
        assert (await ws.execute("mkdir /d")).exit_code == 0
        io = await ws.execute("cd; pwd")
        assert (await io.stdout_str()) == "/d\n"
        assert calls == ["h"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cd_dash_fetches_oldpwd():
    calls, fetch = counting_source({"OLDPWD": "/d"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"OLDPWD": {"from": "fake", "ref": "o"}})
    try:
        assert (await ws.execute("mkdir /d")).exit_code == 0
        io = await ws.execute("cd -")
        assert (await io.stdout_str()) == "/d\n"
        assert calls == ["o"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_relative_cd_fetches_cdpath():
    calls, fetch = counting_source({"CDPATH": "/pp"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"CDPATH": {"from": "fake", "ref": "c"}})
    try:
        assert (await ws.execute("mkdir -p /pp/sub")).exit_code == 0
        io = await ws.execute("cd sub")
        assert (await io.stdout_str()) == "/pp/sub\n"
        assert calls == ["c"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_read_fetches_ifs():
    calls, fetch = counting_source({"IFS": " "})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"IFS": {"from": "fake", "ref": "i"}})
    try:
        io = await ws.execute("echo 'a b' | read v")
        assert io.exit_code == 0
        assert calls == ["i"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_getopts_fetches_optind():
    calls, fetch = counting_source({"OPTIND": "1"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"OPTIND": {"from": "fake", "ref": "g"}})
    try:
        io = await ws.execute("getopts ab o")
        assert io.exit_code == 1
        assert calls == ["g"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_line_mask_beats_an_implicit_read():
    calls, fetch = counting_source({"HOME": "/hh"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"HOME": {"from": "fake", "ref": "h"}})
    try:
        io = await ws.execute("HOME=/d; echo ~")
        assert (await io.stdout_str()) == "/d\n"
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_dynamic_head_fetches_everything_pending():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("h=echo")).exit_code == 0
        assert calls == []
        io = await ws.execute("$h hi")
        assert (await io.stdout_str()) == "hi\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_copy_carries_the_env_template_to_new_sessions():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}, "MODE": "prod"})
    try:
        twin = await ws.copy()
        try:
            twin.create_session("later")
            io = await twin.execute("echo $MODE:$TOKEN", session_id="later")
            assert (await io.stdout_str()) == "prod:t0\n"
            assert calls == ["r"]
        finally:
            await twin.close()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_indirect_expansion_fetches_the_target():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("name=TOKEN")).exit_code == 0
        assert calls == []
        io = await ws.execute("echo ${!name}")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_prior_line_nameref_fetches_its_target():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        session = ws.get_session(ws.default_session_id)
        # Written straight into the session so the declaring line's own
        # opaque-read fetch cannot mask the deref path.
        session.vars["r2"] = ShellVar("TOKEN", frozenset({VarAttr.NAMEREF}))
        io = await ws.execute("echo $r2")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


class DenyNamed(Policy):

    def __init__(self, name: str) -> None:
        self.name = name

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == self.name:
            return Deny(f"{self.name} is off")
        return None


def _policed_ws(deny: str, env) -> Workspace:
    return Workspace({"/": RAMResource()},
                     mode=MountMode.WRITE,
                     env=env,
                     policies=[DenyNamed(deny)])


@pytest.mark.asyncio
async def test_denied_literal_line_never_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws("printenv", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("printenv TOKEN")
        assert io.exit_code == 126
        assert b"printenv is off" in io.stderr
        assert calls == []
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_dynamic_word_deny_fetches_before_the_value_gate():
    # The pre-pass reads a line's text; a command carrying a word only
    # expansion can produce is judged at the per-command gate, which
    # reads values. Expansion is what consumes the fetched value, so
    # for such a line the fetch precedes the verdict, the same way the
    # line's earlier commands would already have run.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws("echo", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("echo $TOKEN")
        assert io.exit_code == 126
        assert b"echo is off" in io.stderr
        assert calls == ["r"]
    finally:
        await ws.close()


class AskNamed(Policy):

    def __init__(self, name: str) -> None:
        self.name = name

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == self.name:
            return Ask(f"{self.name} needs sign-off")
        return None


def _asking_ws(name: str, env, on_ask=None) -> Workspace:
    return Workspace({"/": RAMResource()},
                     mode=MountMode.WRITE,
                     env=env,
                     policies=[AskNamed(name)],
                     on_ask=on_ask)


@pytest.mark.asyncio
async def test_asked_literal_line_fetches_only_after_approval():
    # The fetch is itself an effect, so an ask is answered before it:
    # one question, then one fetch, and the gate spends the grant
    # rather than asking again.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)

    async def approve(record: Decision) -> Decision:
        calls.append("ask")
        return dataclasses.replace(record, outcome=Outcome.ALLOW)

    ws = _asking_ws("printenv", {"TOKEN": {
        "from": "fake",
        "ref": "r"
    }}, approve)
    try:
        io = await ws.execute("printenv TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["ask", "r"]
        assert ws.decisions.pending() == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_asked_literal_line_denied_never_fetches():
    # A host's no arrives before the source is contacted, and the
    # refusal still comes from the gate, in the deny voice.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)

    async def refuse(record: Decision) -> Decision:
        calls.append("ask")
        return dataclasses.replace(record, outcome=Outcome.DENY)

    ws = _asking_ws("printenv", {"TOKEN": {
        "from": "fake",
        "ref": "r"
    }}, refuse)
    try:
        io = await ws.execute("printenv TOKEN")
        assert io.exit_code == 126
        assert b"printenv needs sign-off" in io.stderr
        assert calls == ["ask"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_asked_literal_line_left_pending_never_fetches():
    # With no host inline, the question is recorded once and the fetch
    # is skipped; the answered replay fetches and runs.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _asking_ws("printenv", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("printenv TOKEN")
        assert io.exit_code == 126
        assert b"requires approval" in io.stderr
        assert calls == []
        pending, = ws.decisions.pending()
        await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
        again = await ws.execute("printenv TOKEN")
        assert (await again.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_denied_function_body_never_fetches():
    # The refusal walk covers the same nodes the read walk covers, so a
    # stored body whose one command is denied contributes no read; the
    # invocation still runs and is refused in place, and the pointer
    # stays live for an allowed line.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws("printenv", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        assert (await ws.execute("f() { printenv TOKEN; }")).exit_code == 0
        io = await ws.execute("f")
        assert io.exit_code == 126
        assert b"printenv is off" in io.stderr
        assert calls == []
        io = await ws.execute("echo $TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_denied_transitive_body_never_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws("printenv", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        await ws.execute("inner() { printenv TOKEN; }")
        await ws.execute("outer() { inner; }")
        io = await ws.execute("outer")
        assert io.exit_code == 126
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_denied_body_statement_keeps_a_sibling_reader_fetching():
    # A stored body joins the walk one statement per node, so a refusal
    # drops exactly the denied statement's reads and the sibling still
    # sees the value. Seeded directly: the prejudge pass refuses
    # defining such a body under the same policy, while a stored
    # function can predate it (per-session profiles).
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws("printenv", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        session = ws.get_session(ws.default_session_id)
        tree = parse('printenv TOKEN; echo "e:$TOKEN"')
        session.functions["f"] = [
            node for node in tree.named_children if node.type == "command"
        ]
        io = await ws.execute("f")
        assert (await io.stdout_str()) == "e:t0\n"
        assert b"printenv is off" in io.stderr
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_denied_invocation_skips_the_body_reads():
    # The line's own refusal drops the whole walked set: a body never
    # runs when its invocation is refused, so nothing fetches.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws("f", {"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        await ws.execute("f() { printenv TOKEN; }")
        io = await ws.execute("f")
        assert io.exit_code == 126
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_defining_a_denied_body_is_not_judged():
    # A definition stores text: the command inside it neither reads nor
    # answers for the line, so the eager name still fills and no gate
    # question fires for a command that only got stored.
    calls, fetch = counting_source({"TOKEN": "t0", "E": "ev"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _policed_ws(
        "printenv", {
            "TOKEN": {
                "from": "fake",
                "ref": "r"
            },
            "EAGER": {
                "from": "fake",
                "ref": "re",
                "key": "E",
                "fetch": "eager"
            },
        })
    try:
        io = await ws.execute("g() { printenv TOKEN; }")
        assert io.exit_code == 0
        assert calls == ["re"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_asked_function_body_fetches_only_after_approval():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)

    async def approve(record: Decision) -> Decision:
        calls.append("ask")
        return dataclasses.replace(record, outcome=Outcome.ALLOW)

    ws = _asking_ws("printenv", {"TOKEN": {
        "from": "fake",
        "ref": "r"
    }}, approve)
    try:
        await ws.execute("f() { printenv TOKEN; }")
        io = await ws.execute("f")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["ask", "r"]
        assert ws.decisions.pending() == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_asked_function_body_denied_never_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)

    async def refuse(record: Decision) -> Decision:
        calls.append("ask")
        return dataclasses.replace(record, outcome=Outcome.DENY)

    ws = _asking_ws("printenv", {"TOKEN": {
        "from": "fake",
        "ref": "r"
    }}, refuse)
    try:
        await ws.execute("f() { printenv TOKEN; }")
        io = await ws.execute("f")
        assert io.exit_code == 126
        assert b"printenv needs sign-off" in io.stderr
        assert calls == ["ask"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_env_ignore_environment_never_fetches():
    # `env -i` provably starts empty, so it selects nothing, and the
    # replaced scope drops a pending managed entry too: the inner line
    # must not fetch a name the flag just cleared. The flagless
    # invocation keeps the whole-environment read.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("env -i")
        assert io.exit_code == 0
        assert (await io.stdout_str()) == ""
        inner = await ws.execute("env -i printenv TOKEN")
        assert inner.exit_code == 1
        assert (await inner.stdout_str()) == ""
        assert calls == []
        whole = await ws.execute("env printenv TOKEN")
        assert (await whole.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


async def _cli_noop(config, paths, *texts, **flags):
    return None, IOResult()


def _cli_spec() -> CLISpec:
    return CLISpec(name="mycli",
                   options=(Option(long="--token", type="str",
                                   env="CLI_ROOT"), ),
                   subcommands=(CLISpec(name="alpha",
                                        fn=_cli_noop,
                                        options=(Option(long="--a",
                                                        type="str",
                                                        env="CLI_ALPHA"), )),
                                CLISpec(name="beta",
                                        fn=_cli_noop,
                                        options=(Option(long="--b",
                                                        type="str",
                                                        env="CLI_BETA"), ))))


@pytest.mark.asyncio
async def test_cli_fetches_only_the_invoked_verb_path():
    calls, fetch = counting_source({
        "CLI_ROOT": "r0",
        "CLI_ALPHA": "a0",
        "CLI_BETA": "b0"
    })
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({
        "CLI_ROOT": {
            "from": "fake",
            "ref": "root"
        },
        "CLI_ALPHA": {
            "from": "fake",
            "ref": "alpha"
        },
        "CLI_BETA": {
            "from": "fake",
            "ref": "beta"
        },
    })
    try:
        ws.register_cli("mycli", _cli_spec())
        await ws.execute("mycli alpha")
        assert sorted(calls) == ["alpha", "root"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_alias_invoked_cli_fetches_its_env():
    # The alias value is a textual prefix, so the verb is unknowable
    # until dispatch appends the rest; the walk falls back to the whole
    # spec tree rather than reading "no verb selected".
    calls, fetch = counting_source({"CLI_ROOT": "r0", "CLI_ALPHA": "a0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({
        "CLI_ROOT": {
            "from": "fake",
            "ref": "root"
        },
        "CLI_ALPHA": {
            "from": "fake",
            "ref": "alpha"
        },
    })
    try:
        ws.register_cli("mycli", _cli_spec())
        await ws.execute("shopt -s expand_aliases")
        await ws.execute("alias n='mycli'")
        assert calls == []
        await ws.execute("n alpha")
        assert "alpha" in calls and "root" in calls
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_shadowed_cli_head_does_not_fetch():
    calls, fetch = counting_source({"CLI_ROOT": "r0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"CLI_ROOT": {"from": "fake", "ref": "root"}})
    try:
        ws.register_cli("mycli", _cli_spec())
        await ws.execute("mycli() { echo shadowed; }")
        io = await ws.execute("mycli")
        assert (await io.stdout_str()) == "shadowed\n"
        assert calls == []
        await ws.execute("unset -f mycli")
        await ws.execute("mycli")
        assert calls == ["root"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_masked_assignment_never_fetches():
    # The line replaces the name before anything can read it, so no
    # source is contacted, and the replacement persists.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("TOKEN=local; printenv TOKEN")
        assert (await io.stdout_str()) == "local\n"
        assert calls == []
        later = await ws.execute("printenv TOKEN")
        assert (await later.stdout_str()) == "local\n"
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_masked_unset_never_fetches():
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("unset TOKEN; printenv TOKEN")
        assert io.exit_code == 1
        assert (await io.stdout_str()) == ""
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_env_removal_and_override_never_fetch():
    # `env -u TOKEN` and `env TOKEN=local` both hand the child an
    # environment that cannot observe the standing value, so neither
    # invocation selects the name; the pointer stays pending for a
    # later line that really reads it.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        removed = await ws.execute("env -u TOKEN printenv TOKEN")
        assert removed.exit_code == 1
        assert (await removed.stdout_str()) == ""
        overridden = await ws.execute("env TOKEN=local printenv TOKEN")
        assert (await overridden.stdout_str()) == "local\n"
        assert calls == []
        real = await ws.execute("printenv TOKEN")
        assert (await real.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_prefix_override_never_fetches_and_keeps_the_pointer():
    # `TOKEN=local printenv TOKEN` overrides for that invocation only:
    # no fetch, "local" printed, and the pointer still fetches on the
    # next real read.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("TOKEN=local printenv TOKEN")
        assert (await io.stdout_str()) == "local\n"
        assert calls == []
        real = await ws.execute("echo $TOKEN")
        assert (await real.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_conditional_and_background_masks_do_not_hold():
    # `A=1 && read` runs the read conditionally and `TOKEN=local &`
    # detaches to a subshell where nothing persists: neither position
    # proves a replacement, so the fetch stands.
    calls, fetch = counting_source({"TOKEN": "t0", "A": "a0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("A=1 && printenv TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()
    calls2, fetch2 = counting_source({"TOKEN": "t0"})
    register_secrets("fake2", FakeConfig, fetch2)
    ws2 = _ws({"TOKEN": {"from": "fake2", "ref": "r"}})
    try:
        await ws2.execute("TOKEN=local & printenv TOKEN")
        assert calls2 == ["r"]
    finally:
        await ws2.close()


@pytest.mark.asyncio
async def test_self_read_in_the_prefix_keeps_the_fetch():
    # `TOKEN=$TOKEN` reads before it writes, so the mask may not spend
    # the name.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {"from": "fake", "ref": "r"}})
    try:
        io = await ws.execute("TOKEN=$TOKEN; printenv TOKEN")
        assert (await io.stdout_str()) == "t0\n"
        assert calls == ["r"]
    finally:
        await ws.close()


class DenyUnrelatedWrite(Policy):

    async def pre_session(self, ctx) -> Action | None:
        if ctx.key == "UNRELATED":
            return Deny(f"no writing {ctx.key}")
        return None


@pytest.mark.asyncio
async def test_session_write_policy_disables_masking():
    # A pre_session rule may refuse a write mid-line while later
    # statements still run, so under one no assignment or unset is
    # trusted to land: the fetch keeps today's shape and the output is
    # unchanged.
    calls, fetch = counting_source({"TOKEN": "t0"})
    register_secrets("fake", FakeConfig, fetch)
    ws = _ws({"TOKEN": {
        "from": "fake",
        "ref": "r"
    }},
             policies=[DenyUnrelatedWrite()])
    try:
        io = await ws.execute("TOKEN=local; printenv TOKEN")
        assert (await io.stdout_str()) == "local\n"
        assert calls == ["r"]
    finally:
        await ws.close()
