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

from mirage.policy import (Ask, CommandContext, Deny, Pending, render_deny,
                           render_pending)
from mirage.runtime.policy import parsed_commands
from mirage.types import PathSpec
from mirage.utils.path import CycleError, resolve_path
from mirage.workspace.executor.builtins.links.links import follow_paths
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.command.routing import (path_flag_scopes,
                                                       positional_scopes,
                                                       program_tokens)
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.route import (SLASH_KEEPS_LAST, command_visible,
                                    follows_last_component, is_tool)
from mirage.workspace.session import Session


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
    report; here the typed paths stand.

    Args:
        name (str): command name.
        args (list[str]): the words after it, as typed.
        operands (Sequence[str | PathSpec]): the same words, classified.
        namespace (Namespace | None): the link table; None outside a
            workspace.
        cwd (str): session working directory.
    """
    scopes = [p for p in operands if isinstance(p, PathSpec)]
    scopes.extend(path_flag_scopes(name, args, cwd))
    if "/" in name:
        # A slash-carrying head word is a file the line executes, and it
        # lives in argv[0], not the operands, so a path-pattern guard
        # would never see it without this row.
        scopes.insert(0, _to_scope(resolve_path(name, cwd)))
    if namespace is None or not namespace.nodes or not operands:
        return scopes
    try:
        followed = follow_paths(namespace,
                                list(operands),
                                follows_last_component(name, [name, *args]),
                                slash_follows=name not in SLASH_KEEPS_LAST)
    except CycleError:
        return scopes
    seen = {p.virtual for p in scopes}
    for item in followed:
        if isinstance(item, PathSpec) and item.virtual not in seen:
            seen.add(item.virtual)
            scopes.append(item)
    return scopes


async def admit(
    name: str,
    args: list[str],
    operands: Sequence[str | PathSpec],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
) -> Refusal | None:
    """The command plane's admission of one command: visibility, then
    the policy chain, then the approval door.

    The one gate every command class passes through, in the tree
    (``_run_argv``, once the words are expanded) and for a line a
    runtime takes whole (``admit_line``, per parsed command). A word
    the session's allow lists do not install is bash's "command not
    found" before any admission hook, so an unlisted tool never leaks
    a deny reason; a Deny renders in the outcome table's voice; an Ask
    is answered by the door from the session's grants or the host.

    Args:
        name (str): command name, expanded.
        args (list[str]): the words after it.
        operands (Sequence[str | PathSpec]): the same words, classified.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            approval door and the CLI installs.
        namespace (Namespace | None): the link table.
    """
    if not command_visible(name, session):
        return Refusal(f"{name}: command not found\n".encode(), 127)
    tokens, program = program_tokens(registry, name, args, session.cwd)
    ctx = CommandContext(command=name,
                         paths=tuple(
                             policy_scopes(name, args, operands, namespace,
                                           session.cwd)),
                         operands=tuple(
                             positional_scopes(name, args, session.cwd,
                                               list(operands))),
                         argv=tuple(args),
                         cwd=session.cwd,
                         registry=registry,
                         session_id=session.session_id,
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


async def admit_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
) -> Refusal | None:
    """Admit every command of a line a runtime takes whole.

    A whole line is a command like any other: the runtime does the
    expanding, so each parsed command is admitted on its literal
    words, classified as typed (a path-shaped word is a path, an
    installed CLI's verb path is walked), and the first refusal is
    the line's. A word the gate cannot read (``$cmd``) is a word no
    allow list covers, which fails toward refusal.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            approval door and the CLI installs.
        namespace (Namespace | None): the link table.
    """
    for parsed in parsed_commands(ast, registry.clis.names()):
        args = list(parsed.words[1:])
        classified = classify_parts([parsed.command, *args], registry,
                                    session.cwd)
        refusal = await admit(parsed.command, args, classified[1:], session,
                              registry, namespace)
        if refusal is not None:
            return refusal
    return None
