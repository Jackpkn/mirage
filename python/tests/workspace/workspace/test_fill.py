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

from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from mirage import Action, CommandContext, Deny, MountMode, Policy, Workspace
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.io import IOResult
from mirage.resource.ram import RAMResource
from mirage.secrets import registry
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
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
