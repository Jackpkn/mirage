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

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from mirage.context.session_context import session_path_allowed
from mirage.io.types import ByteSource
from mirage.policy import (Ask, CommandContext, CommandsSpec, Deny, Pending,
                           render_deny, render_pending)
from mirage.policy.match import has_rules, reads_args
from mirage.runtime.policy import command_nodes
from mirage.shell import parse
from mirage.shell.helpers import (get_parts, get_text, literal_word,
                                  split_env_prefix)
from mirage.types import PathSpec
from mirage.utils.path import CycleError, resolve_path
from mirage.workspace.executor.builtins.links.links import follow_paths
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.command.routing import (CWD_DEFAULT_RAW,
                                                       default_cwd_operand,
                                                       path_flag_scopes,
                                                       positional_scopes,
                                                       program_tokens)
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.inner_lines import Word, inner_lines
from mirage.workspace.route import (SLASH_KEEPS_LAST, command_visible,
                                    follows_last_component, is_tool)
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir


@dataclass(frozen=True, slots=True)
class Refusal:
    """What the command plane prints when a line does not get to run.

    Args:
        stderr (bytes): the message, newline-terminated.
        exit_code (int): 127 for a word the session cannot see, 126 for
            a whole-command refusal or an unanswered ask, the operand
            code (1, tar 2) for an operand-scoped refusal.
    """

    stderr: bytes
    exit_code: int


def policy_scopes(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    namespace: Namespace | None,
    cwd: str,
    implied: PathSpec | None = None,
) -> list[PathSpec]:
    """The paths a path-pattern guard reads for a line.

    The operands as typed and the values of path-valued flags, then, for
    a command that follows links, the targets they resolve to: ``cat
    /data/link`` reads ``/data/secret``, so a rule protecting the target
    has to see it, and a command-scoped rule never runs at the op door
    where the resolved path would otherwise be checked. The follow
    policy is the command's own (``follows_last_component``: ``rm``,
    ``mv``, ``ln``, ``stat``, ``tar`` ... act on the link itself, ``-L``
    turns following back on), the same one the router applies to the
    operands before the handler runs, so a rule sees exactly the path
    the command will touch. A loop is left to that later step to
    report; here the typed paths stand. Last comes the operand a bare
    ``ls``/``find``/``du``/``tree``/``grep -r`` implies, the working
    directory, which the executor injects after the gate and which a
    rule on that directory has to see.

    Args:
        name (str): command name.
        args (list[str]): the words after it, as typed.
        operands (Sequence[str | PathSpec]): the same words, classified.
        namespace (Namespace | None): the link table; None outside a
            workspace.
        cwd (str): session working directory.
        implied (PathSpec | None): the working-directory operand the
            command reads when typed bare, None when it names a path.
    """
    scopes = [p for p in operands if isinstance(p, PathSpec)]
    scopes.extend(path_flag_scopes(name, args, cwd))
    if "/" in name:
        # A slash-carrying head word is a file the line executes, and it
        # lives in argv[0], not the operands, so a path-pattern guard
        # would never see it without this row.
        scopes.insert(0, _to_scope(resolve_path(name, cwd)))
    if namespace is not None and namespace.nodes and operands:
        try:
            followed = follow_paths(namespace,
                                    list(operands),
                                    follows_last_component(
                                        name, [name, *args]),
                                    slash_follows=name not in SLASH_KEEPS_LAST)
        except CycleError:
            followed = []
        seen = {p.virtual for p in scopes}
        for item in followed:
            if isinstance(item, PathSpec) and item.virtual not in seen:
                seen.add(item.virtual)
                scopes.append(item)
    if implied is not None and implied.virtual not in {
            p.virtual
            for p in scopes
    }:
        scopes.append(implied)
    return scopes


def _seen(session: Session, specs: list[PathSpec]) -> tuple[PathSpec, ...]:
    """The paths of a line the session can see.

    A hidden path is nonexistent for the session, so no policy may
    learn of it either: a rule scoped to it must not fire (the reason
    would say the path is there), an ask must not be raised for it (a
    request would name it to the host), and the line runs on to the
    door, which answers ENOENT like any other absent path.

    Args:
        session (Session): the session running the line.
        specs (list[PathSpec]): the paths as the gate collected them.
    """
    return tuple(p for p in specs if session_path_allowed(session, p.virtual))


async def admit(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
    stdin: ByteSource | None = None,
) -> Refusal | None:
    """The command plane's admission of one command: visibility, then
    the policy chain, then the approval door.

    The one gate every command class passes through, in the tree
    (``_run_argv``, once the words are expanded) and for a line a
    runtime takes whole (``admit_line``, per parsed command). A word
    the session's allow lists do not install is bash's "command not
    found" before any admission hook, so an unlisted tool never leaks
    a deny reason; a path the session cannot see is dropped before any
    hook, so a rule never names it and the door answers ENOENT; a Deny
    renders in the outcome table's voice; an Ask is answered by the
    door from the session's grants or the host.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            approval door and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to, for an
            approval request.
        stdin (ByteSource | None): the line's stdin, which decides
            whether a bare ``rg`` reads the working directory.
    """
    if not command_visible(name, session):
        return Refusal(f"{name}: command not found\n".encode(), 127)
    tokens, program = program_tokens(registry, name, args, session.cwd)
    implied = (default_cwd_operand([name, *operands], name, registry,
                                   session.cwd, stdin)
               if name in CWD_DEFAULT_RAW else None)
    ctx = CommandContext(command=name,
                         paths=_seen(
                             session,
                             policy_scopes(name, args, operands, namespace,
                                           session.cwd, implied)),
                         operands=_seen(
                             session,
                             positional_scopes(name, args, session.cwd,
                                               list(operands))),
                         argv=tuple(args),
                         cwd=session.cwd,
                         registry=registry,
                         session_id=session.session_id,
                         agent_id=agent_id,
                         tokens=tokens,
                         program=program,
                         tool=is_tool(name, session))
    asked = await registry.policies.pre_command(ctx)
    # An Ask is the chain's answer only after every Deny had its say;
    # the door answers it from the session's grants or the host, so a
    # grant never re-opens a deny.
    verdict: Deny | Pending | None = (await registry.approvals.resolve(
        ctx, asked) if isinstance(asked, Ask) else asked)
    if verdict is None:
        return None
    err, code = (render_pending(name, verdict) if isinstance(verdict, Pending)
                 else render_deny(name, verdict))
    return Refusal(err, code)


def _refuse(name: str, reason: str) -> Refusal:
    err, code = render_deny(name, Deny(reason))
    return Refusal(err, code)


def _unreadable(raw: str) -> str:
    return f"cannot read {raw} before the runtime expands it"


async def _admit_words(
    words: list[Word],
    open_: bool,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str,
    layers: tuple[CommandsSpec, ...],
) -> Refusal | None:
    """Admit one command of a whole line on the words the gate read,
    then whatever lines the command runs in turn.

    Args:
        words (list[Word]): the command's words, name first.
        open_ (bool): whether the runtime appends operands the gate
            cannot read (``xargs``, ``find -exec``).
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            approval door and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
        layers (tuple[CommandsSpec, ...]): the session's command tiers.
    """
    head = words[0]
    if head.text is None and has_rules(layers):
        return _refuse(head.raw, _unreadable(head.raw))
    name = head.value
    args = [w.value for w in words[1:]]
    classified = classify_parts([name, *args], registry, session.cwd)
    refusal = await admit(name, args, classified[1:], session, registry,
                          namespace, agent_id)
    if refusal is not None:
        return refusal
    unread = next((w.raw for w in words[1:] if w.text is None), None)
    if (unread is not None or open_) and reads_args(layers, name):
        return _refuse(
            name,
            _unreadable(unread)
            if unread is not None else "runs on operands the gate cannot read")
    for inner in inner_lines(name, words[1:]):
        if not inner.readable:
            if has_rules(layers):
                return _refuse(name, "runs lines the gate cannot read")
            continue
        if inner.line is not None:
            refusal = await admit_line(parse(inner.line), session, registry,
                                       namespace, agent_id)
        else:
            refusal = await _admit_words(list(inner.argv), inner.open, session,
                                         registry, namespace, agent_id, layers)
        if refusal is not None:
            return refusal
    return None


async def admit_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
) -> Refusal | None:
    """Admit every command of a line a runtime takes whole.

    A whole line is a command like any other, but the runtime does the
    expanding, so the gate reads the line as typed: each command is
    admitted on its literal words (quotes removed, escapes resolved, a
    path-shaped word a path, an installed CLI's verb path walked), and
    the first refusal is the line's. A word only the runtime can expand
    (``$cmd``, ``"$p"``, ``$(...)``, ``{a,b}``) is refused wherever a
    rule in force would have read it: as the command name whenever the
    session has any command rule, as an argument when a rule reads that
    command's arguments (a pattern with a token after the name, a
    path-scoped or mount-scoped rule). The words that run other words
    (``eval``, ``sh -c``, ``xargs``, ``env`` ... see ``inner_lines``)
    have those lines admitted in turn, and a line the gate cannot read
    at all (a sourced file, a script, ``eval "$p"``) is refused under
    any command rule. With no rule in force nothing is refused on this
    account: the words are admitted as typed, which is all a coded
    policy ever saw.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            approval door and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
    """
    layers = session.command_layers
    home = home_dir(session)
    for node in command_nodes(ast):
        _, parts = split_env_prefix(get_parts(node))
        words = [
            Word(get_text(part), literal_word(part, home)) for part in parts
        ]
        if not words:
            continue
        refusal = await _admit_words(words, False, session, registry,
                                     namespace, agent_id, layers)
        if refusal is not None:
            return refusal
    return None
