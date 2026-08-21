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

from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
from mirage.policy.types import AdmissionRules
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.route import (SHELL_CONSUMERS, Consumer, command_visible,
                                    route, route_all, verb_visible)
from mirage.workspace.session import Session


def _fixture() -> tuple[Session, Workspace]:
    ws = Workspace(resources={"/ram": (RAMResource(), MountMode.WRITE)})
    return Session(session_id="t"), ws


async def _noop(config, paths, *texts, **flags):
    return None, IOResult()


def _cli_tree() -> CLISpec:
    return CLISpec(name="prog", subcommands=(CLISpec(name="run", fn=_noop), ))


def test_builtins_route_session():
    session, ws = _fixture()
    for name in ("cd", "echo", "export", "history", "test", "xargs"):
        assert route(name, session, ws._registry) is Consumer.SESSION


def test_unsupported_builtins_route_session():
    session, ws = _fixture()
    assert route("exec", session, ws._registry) is Consumer.SESSION


def test_namespace_commands():
    session, ws = _fixture()
    assert route("ln", session, ws._registry) is Consumer.NAMESPACE
    assert route("readlink", session, ws._registry) is Consumer.NAMESPACE


def test_function_routes_function():
    session, ws = _fixture()
    session.functions["greet"] = []
    assert route("greet", session, ws._registry) is Consumer.FUNCTION


def test_builtin_shadows_function():
    session, ws = _fixture()
    session.functions["echo"] = []
    assert route("echo", session, ws._registry) is Consumer.SESSION


def test_function_shadows_mount_command():
    session, ws = _fixture()
    session.functions["cat"] = []
    assert route("cat", session, ws._registry) is Consumer.FUNCTION


def test_mount_command_routes_mount():
    session, ws = _fixture()
    assert route("cat", session, ws._registry) is Consumer.MOUNT
    assert route("grep", session, ws._registry) is Consumer.MOUNT


def test_unregistered_name_routes_unknown():
    session, ws = _fixture()
    assert route("nosuchcmd", session, ws._registry) is Consumer.UNKNOWN


def test_installed_cli_routes_cli():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    assert route("prog", session, ws._registry) is Consumer.CLI


def test_function_shadows_installed_cli():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.functions["prog"] = []
    assert route("prog", session, ws._registry) is Consumer.FUNCTION


def test_unregistered_cli_routes_unknown():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    ws.unregister_cli("prog")
    assert route("prog", session, ws._registry) is Consumer.UNKNOWN


def test_shell_consumers_resolve_globs():
    assert Consumer.SESSION in SHELL_CONSUMERS
    assert Consumer.NAMESPACE in SHELL_CONSUMERS
    assert Consumer.FUNCTION in SHELL_CONSUMERS
    # A CLI is a program: bash hands programs glob matches, never
    # patterns.
    assert Consumer.CLI in SHELL_CONSUMERS
    assert Consumer.MOUNT not in SHELL_CONSUMERS
    assert Consumer.UNKNOWN not in SHELL_CONSUMERS


def test_route_all_reports_every_layer_winner_first():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    assert route_all("prog", session, ws._registry) == [Consumer.CLI]
    session.functions["prog"] = []
    assert route_all("prog", session,
                     ws._registry) == [Consumer.FUNCTION, Consumer.CLI]


def test_route_all_is_empty_where_route_says_unknown():
    session, ws = _fixture()
    assert route_all("bogus", session, ws._registry) == []
    assert route("bogus", session, ws._registry) is Consumer.UNKNOWN


def test_route_agrees_with_the_first_layer_route_all_reports():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.functions["greet"] = []
    for name in ("cd", "ln", "greet", "prog", "cat", "bogus"):
        layers = route_all(name, session, ws._registry)
        winner = layers[0] if layers else Consumer.UNKNOWN
        assert route(name, session, ws._registry) is winner


def test_verb_visible_answers_below_the_head_word_command_visible_answers():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("prog run", ))
    # Dispatch routes by the head word, which stays visible: one line of
    # the tree runs.
    assert command_visible("prog", session)
    assert route("prog", session, ws._registry) is Consumer.CLI
    assert verb_visible("prog", (), session)
    assert verb_visible("prog", ("run", ), session)
    # A verb the list does not reach is not this session's to discover,
    # though the head word it hangs off is.
    assert not verb_visible("prog", ("stop", ), session)
    # No list: every verb of every tree.
    session.commands = None
    assert verb_visible("prog", ("stop", ), session)


def test_allow_lists_filter_the_tool_layers_and_spare_grammar_and_functions():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("cat", "prog", "ln"))
    reg = ws._registry
    # Listed: visible in its layer, whichever layer that is.
    assert route("cat", session, reg) is Consumer.MOUNT
    assert route("prog", session, reg) is Consumer.CLI
    assert route("ln", session, reg) is Consumer.NAMESPACE
    # Unlisted: not a command for the session (sleep is a tool-tier
    # builtin, rm a mount command).
    assert route("sleep", session, reg) is Consumer.UNKNOWN
    assert route("rm", session, reg) is Consumer.UNKNOWN
    assert route_all("rm", session, reg) == []
    assert not command_visible("rm", session)
    # Grammar (cd, echo, test, ...) is never a subject.
    assert route("cd", session, reg) is Consumer.SESSION
    assert route("echo", session, reg) is Consumer.SESSION
    assert command_visible("cd", session)
    # A function is the session's own state, visible where it is what
    # runs; named after a hidden builtin it is as unreachable as the
    # builtin, since builtins shadow functions here.
    session.functions["deploy"] = []
    assert route("deploy", session, reg) is Consumer.FUNCTION
    assert command_visible("deploy", session)
    session.functions["sleep"] = []
    assert route("sleep", session, reg) is Consumer.UNKNOWN
    assert not command_visible("sleep", session)
    # A function shadowing a hidden CLI or mount command runs, and the
    # hidden layer stays out of `type -a`.
    session.functions["rm"] = []
    assert route_all("rm", session, reg) == [Consumer.FUNCTION]
    # No allow list at all: nothing filtered (the function still
    # shadows).
    session.commands = None
    assert route_all("rm", session, reg) == [Consumer.FUNCTION, Consumer.MOUNT]
    assert route("sleep", session, reg) is Consumer.SESSION
