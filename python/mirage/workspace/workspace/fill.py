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

import logging
from collections.abc import Mapping, Sequence

import tree_sitter

from mirage.commands.cli.walk import invoked_env_names
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.table import VFSRuntime
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import fetch_secret
from mirage.shell.parse import (command_invocations, command_words, env_reads,
                                opaque_reads, referenced_names)
from mirage.shell.types import FunctionBody
from mirage.shell.variable import ManagedRef, with_value
from mirage.utils.hidden import var_hidden
from mirage.workspace.lookup.lookup import lookup
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.session.state import deref

logger = logging.getLogger(__name__)


def _defined_bodies(node: tree_sitter.Node) -> dict[str, tree_sitter.Node]:
    """Function bodies the line itself defines, by name.

    Args:
        node (tree_sitter.Node): the parsed line.
    """
    out: dict[str, tree_sitter.Node] = {}
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type == "function_definition":
            name_node = current.child_by_field_name("name")
            body = current.child_by_field_name("body")
            text = name_node.text if name_node is not None else None
            if text and body is not None:
                out[text.decode()] = body
        stack.extend(current.named_children)
    return out


def line_nodes(
        node: tree_sitter.Node,
        functions: Mapping[str, FunctionBody]) -> list[tree_sitter.Node]:
    """The line's tree plus every function body it can invoke.

    A body runs at invocation, not where it is defined, so the read
    walks skip definition subtrees; this is where an invoked body joins
    back in. An invocation word resolves to the line's own definition
    first (a same-line redefinition shadows the stored one), then to
    the session's stored functions, transitively (a body invoking
    another function pulls that body in too), each name once, so mutual
    recursion terminates.

    Args:
        node (tree_sitter.Node): the parsed line.
        functions (Mapping[str, FunctionBody]): the session's stored
            shell functions.
    """
    defined = _defined_bodies(node)
    nodes: list[tree_sitter.Node] = [node]
    seen: set[str] = set()
    frontier: list[tree_sitter.Node] = [node]
    while frontier:
        current = frontier.pop()
        for word in command_words(current):
            if word in seen:
                continue
            seen.add(word)
            local = defined.get(word)
            bodies = ([local] if local is not None else list(
                functions.get(word) or ()))
            nodes.extend(bodies)
            frontier.extend(bodies)
    return nodes


def guest_bound(nodes: Sequence[tree_sitter.Node],
                decision: RouteDecision | None,
                static_bindings: Mapping[str, Runtime | None]) -> bool:
    """Whether any of the line's commands runs on a guest runtime.

    A guest receives the exported environment as one snapshot, so
    every managed name may be read whatever the line spells --
    ``python3 -c 'os.environ[...]'`` never writes a ``$NAME`` the walk
    could see. The vfs runtime is the executor itself, whose commands
    read vars one at a time, so it does not count. Keyed on the walked
    set's own command words (stored function bodies included) because
    the static table binds every captured command in the workspace, not
    this line's.

    Args:
        nodes (Sequence[tree_sitter.Node]): the line's walked set
            (``line_nodes``).
        decision (RouteDecision | None): the line's placement decision,
            None when only static bindings apply.
        static_bindings (Mapping[str, Runtime | None]): the registry's
            standing command bindings, the fallback ``whole_line`` uses.
    """
    bindings = (decision.bindings if decision is not None else static_bindings)
    if not bindings:
        return False
    words: set[str] = {"*"}
    for node in nodes:
        words |= command_words(node)
    for word in words:
        runtime = bindings.get(word)
        if runtime is not None and not isinstance(runtime, VFSRuntime):
            return True
    return False


def cli_env_names(nodes: Sequence[tree_sitter.Node], session: Session,
                  registry: MountRegistry) -> frozenset[str]:
    """Env names the line's installed CLIs are about to read.

    An installed CLI reads a managed name through ``Option.env`` with
    no ``$NAME`` in the line's text, so the fill set has to be told. A
    head word counts only when dispatch would actually run the CLI
    (``lookup``): a function, builtin or namespace command shadowing
    the name wins routing, and a head the session's profile hides never
    runs at all. The invocation's literal words then prune the tree
    (``invoked_env_names``), so ``ntn api get`` contributes the api and
    get chain rather than every sibling verb's options.

    Args:
        nodes (Sequence[tree_sitter.Node]): the line's walked set
            (``line_nodes``).
        session (Session): the session the line runs in.
        registry (MountRegistry): the registry holding the installs.
    """
    out: set[str] = set()
    for node in nodes:
        for head, args in command_invocations(node):
            install = registry.clis.get(head)
            if install is None:
                continue
            if lookup(head, session, registry) is not Consumer.CLI:
                continue
            words = (None if any(arg is None for arg in args) else frozenset(
                arg for arg in args
                if arg is not None and not arg.startswith("-")))
            out |= invoked_env_names(install.spec, words)
    return frozenset(out)


def _wanted(session: Session, nodes: Sequence[tree_sitter.Node],
            pending: Mapping[str, ManagedRef],
            cli_env_names: frozenset[str]) -> frozenset[str]:
    """The pending names the line's walked set is about to read.

    A whole-environment render or an opaque read (``opaque_reads``)
    selects everything pending; otherwise the set is the walk's
    references (nameref targets resolved through the session), the
    printing forms' explicit targets, the routed CLIs' env names, and
    the eager-marked entries.

    Args:
        session (Session): the session the line runs in.
        nodes (Sequence[tree_sitter.Node]): the line's walked set.
        pending (Mapping[str, ManagedRef]): unfetched managed vars.
        cli_env_names (frozenset[str]): env names the line's installed
            CLIs read (``cli_env_names``).
    """
    referenced: set[str] = set()
    printed: set[str] = set()
    for node in nodes:
        rendered, names = env_reads(node)
        if rendered or opaque_reads(node):
            return frozenset(pending)
        printed |= names
        referenced |= referenced_names(node)
    wanted = printed | cli_env_names | {
        name
        for name, ref in pending.items() if ref.eager
    }
    for name in referenced:
        wanted.add(name)
        wanted.add(deref(session, name))
    return frozenset(wanted & pending.keys())


def _pending(session: Session) -> dict[str, ManagedRef]:
    """The session's unfetched managed names, hidden ones excluded.

    A hidden name never fetches at all: the snapshot filters it and
    expansion reads it as unset, so no fetch could ever be visible.

    Args:
        session (Session): the session the line runs in.
    """
    out: dict[str, ManagedRef] = {}
    for name, var in session.vars.items():
        if var.managed is None or var.value is not None:
            continue
        if var_hidden(session.hidden_vars, name):
            continue
        out[name] = var.managed
    return out


def fill_names(session: Session, nodes: Sequence[tree_sitter.Node], *,
               whole: bool, cli_env_names: frozenset[str]) -> frozenset[str]:
    """The managed names one line is about to read, without fetching.

    Pure planning, split from :func:`fill_env` so the executor can
    consult the admission text-pass between deciding and fetching: a
    line already denied on its literal words never reaches a source.

    Args:
        session (Session): the session the line runs in.
        nodes (Sequence[tree_sitter.Node]): the line's walked set
            (``line_nodes``).
        whole (bool): the line runs as one opaque program (a whole-line
            runtime), so every managed name may be read.
        cli_env_names (frozenset[str]): env names the line's installed
            CLIs read (``cli_env_names``).
    """
    pending = _pending(session)
    if not pending:
        return frozenset()
    if whole:
        return frozenset(pending)
    return _wanted(session, nodes, pending, cli_env_names)


async def fill_env(session: Session, names: frozenset[str]) -> None:
    """Fetch the named managed values into the session.

    The session is the truth, not the workspace's declaration: it may
    carry entries the workspace never declared (per-session env, a
    hydrated record), and a var that already holds a value never
    refetches -- which also makes the re-entrant fill of a nested eval
    idempotent. Fetches group by ``(source, ref)``, one await per
    distinct secret, and the fetched value lands directly in
    ``session.vars`` with the pointer kept: this is the one host-tier
    writer, above the agent's gated door.

    A failed fetch, or a secret without the wanted field, raises
    SecretsError naming the variable and the source -- never the ref,
    never any value, and never the source's own words, which go to the
    host log instead (an SDK error can spell paths or identifiers, and
    stderr is the agent's to read). The executor folds it into the
    line's result (exit 1), so a dead source fails exactly the
    commands that need it.

    Args:
        session (Session): the session the line runs in, written here.
        names (frozenset[str]): the fetch set (``fill_names``).
    """
    if not names:
        return
    pending = _pending(session)
    records = {name: session.vars[name] for name in pending}
    groups: dict[tuple[str, str], list[str]] = {}
    for name in sorted(names & pending.keys()):
        pointer = pending[name]
        groups.setdefault((pointer.source, pointer.ref), []).append(name)
    for (source, ref), group in groups.items():
        listed = ", ".join(group)
        try:
            secret = await fetch_secret(source, ref)
        except Exception as exc:
            logger.warning("secret fetch for %s from %s failed: %s", listed,
                           source, exc)
            raise SecretsError(
                f"{listed}: cannot fetch from {source}") from exc
        for name in group:
            key = pending[name].key
            value = secret.fields.get(key)
            if value is None:
                had = ", ".join(sorted(secret.fields))
                raise SecretsError(
                    f"{name}: wanted field {key!r}, the {source} secret "
                    f"has {{{had}}}")
            session.vars[name] = with_value(records[name], value)
