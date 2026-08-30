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

from collections.abc import Mapping

import tree_sitter

from mirage.commands.cli.walk import env_names
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.table import VFSRuntime
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import fetch_secret
from mirage.shell.parse import command_words, referenced_names
from mirage.shell.variable import ManagedRef, ShellVar, with_value
from mirage.workspace.cli import CLIInstall
from mirage.workspace.session import Session

# Commands that render the whole environment, so every managed name is
# about to be read whether or not the line spells one.
WHOLE_ENV_COMMANDS = frozenset({"env", "printenv", "export", "declare", "set"})


def guest_bound(node: tree_sitter.Node, decision: RouteDecision | None,
                static_bindings: Mapping[str, Runtime | None]) -> bool:
    """Whether any of the line's commands runs on a guest runtime.

    A guest receives the exported environment as one snapshot, so
    every managed name may be read whatever the line spells --
    ``python3 -c 'os.environ[...]'`` never writes a ``$NAME`` the walk
    could see. The vfs runtime is the executor itself, whose commands
    read vars one at a time, so it does not count. Keyed on the line's
    own command words because the static table binds every captured
    command in the workspace, not this line's.

    Args:
        node (tree_sitter.Node): the parsed line.
        decision (RouteDecision | None): the line's placement decision,
            None when only static bindings apply.
        static_bindings (Mapping[str, Runtime | None]): the registry's
            standing command bindings, the fallback ``whole_line`` uses.
    """
    bindings = (decision.bindings if decision is not None else static_bindings)
    if not bindings:
        return False
    for word in command_words(node) | {"*"}:
        runtime = bindings.get(word)
        if runtime is not None and not isinstance(runtime, VFSRuntime):
            return True
    return False


def cli_env_names(node: tree_sitter.Node,
                  clis: Mapping[str, CLIInstall]) -> frozenset[str]:
    """Env names the line's installed CLIs read.

    An installed CLI reads a managed name through ``Option.env`` with
    no ``$NAME`` in the line's text, so the fill set has to be told:
    for each command word that is an installed head word, every env
    name its program tree declares.

    Args:
        node (tree_sitter.Node): the parsed line.
        clis (Mapping[str, CLIInstall]): installed CLIs by head word.
    """
    if not clis:
        return frozenset()
    words = command_words(node)
    out: set[str] = set()
    for head, install in clis.items():
        if head in words:
            out |= env_names(install.spec)
    return frozenset(out)


async def fill_env(session: Session, node: tree_sitter.Node, *, whole: bool,
                   cli_env_names: frozenset[str]) -> None:
    """Fetch the managed values one line is about to read.

    The session is the truth, not the workspace's declaration: it may
    carry entries the workspace never declared (per-session env, a
    hydrated record), and a var that already holds a value never
    refetches -- which also makes the re-entrant fill of a nested eval
    idempotent. Fetches group by ``(source, ref)``, one await per
    distinct secret, and the fetched value lands directly in
    ``session.vars`` with the pointer kept: this is the one host-tier
    writer, above the agent's gated door.

    A failed fetch, or a secret without the wanted field, raises
    SecretsError naming the variable and the source -- never the ref
    and never any value -- and the executor folds it into the line's
    result (exit 1), so a dead source fails exactly the commands that
    need it.

    Args:
        session (Session): the session the line runs in, written here.
        node (tree_sitter.Node): the parsed line.
        whole (bool): the line runs as one opaque program (a whole-line
            runtime), so every managed name may be read.
        cli_env_names (frozenset[str]): env names the line's installed
            CLIs read (``cli_env_names``).
    """
    pending: dict[str, ManagedRef] = {}
    records: dict[str, ShellVar] = {}
    for name, var in session.vars.items():
        if var.managed is None or var.value is not None:
            continue
        pending[name] = var.managed
        records[name] = var
    if not pending:
        return
    if whole or WHOLE_ENV_COMMANDS & command_words(node):
        names = frozenset(pending)
    else:
        wanted = (referenced_names(node) | cli_env_names
                  | {n
                     for n, ref in pending.items() if ref.eager})
        names = wanted & pending.keys()
    if not names:
        return
    groups: dict[tuple[str, str], list[str]] = {}
    for name in sorted(names):
        pointer = pending[name]
        groups.setdefault((pointer.source, pointer.ref), []).append(name)
    for (source, ref), group in groups.items():
        try:
            secret = await fetch_secret(source, ref)
        except Exception as exc:
            raise SecretsError(
                f"{', '.join(group)}: cannot fetch from {source}: {exc}"
            ) from exc
        for name in group:
            key = pending[name].key
            value = secret.fields.get(key)
            if value is None:
                had = ", ".join(sorted(secret.fields))
                raise SecretsError(
                    f"{name}: wanted field {key!r}, the {source} secret "
                    f"has {{{had}}}")
            session.vars[name] = with_value(records[name], value)
