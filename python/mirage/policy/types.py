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

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, ClassVar, Literal, Protocol

from mirage.types import Limit, PathSpec, Producer


class MountRootQuery(Protocol):
    """The one registry question policy hooks may ask.

    MountRegistry satisfies this structurally; the narrow protocol keeps
    this package a leaf (no workspace imports), so the registry can host
    a Policies instance without a cycle.
    """

    def is_mount_root(self, path: str) -> bool:
        ...


class DenyScope(StrEnum):
    """What a command-plane refusal is about, which picks its voice.

    COMMAND refuses the whole line: ``<cmd>: policy denied: <reason>``,
    exit 126. OPERAND refuses one operand and keeps the GNU voice
    ``<cmd>: <reason>`` (the reason names the operand, as
    ``rm: cannot remove 'x': ...`` does), exit 1, or the command's own
    fatal code where GNU differs (tar exits 2). The exit code and errno
    derive from the plane and this scope, never from a number a policy
    picks, so a document deny and a coded one are indistinguishable.
    """

    COMMAND = "command"
    OPERAND = "operand"


@dataclass(frozen=True, slots=True)
class Deny:
    """Refuse the command, op or session write, with a reason.

    Rendered by the door it fires at: the command plane prints it in
    the scope's voice (DenyScope), the op doors raise EACCES with it,
    the session door EACCES too.

    Args:
        reason (str): why, without the command name and without a
            trailing newline; the door adds both.
        scope (DenyScope): whole command or one operand; ignored off
            the command plane.
    """

    kind: ClassVar[str] = "deny"

    reason: str
    scope: DenyScope = DenyScope.COMMAND


@dataclass(frozen=True, slots=True)
class CommandRule:
    """One admission rule of the permissions document: refuse (or ask
    about) matching commands, on matching paths when it names any.

    It is the compiled element of ``commands.deny`` and ``commands.ask``
    wherever the role writes one, and reaches the workspace only inside
    that document; the internal RulePolicy is what evaluates it. The
    document writes a rule in one of three shapes, and each compiles to
    rules of this class: a list of command patterns (a whole-line rule
    on each, no paths), a mapping of command pattern to its paths (one
    command to many paths, one rule per command, so a path is never
    stated beside a command it was not meant for), or paths alone (a
    rule on every command, at the op door too). A command entry is a
    token-prefix pattern over the line as the door normalizes it (``rm``
    is every rm line, ``git push`` every ``git push ...``, a ``*`` token
    any one token). Path entries use the document's one grammar: an
    entry with ``*``, ``?`` or ``[`` is a pattern (repo fnmatch dialect,
    ``*`` crossing ``/``, a slashless pattern matching any name
    component), anything else is an exact path and its subtree. Every
    entry is absolute or a name pattern, holds a token (a blank one
    would be the root), and inside a mount section must name something
    under that mount root.

    Args:
        reason (str): why the command is refused, shown on stderr.
        commands (tuple[str, ...]): command patterns the rule applies
            to; empty means every command. A path-scoped rule carries
            exactly one.
        paths (tuple[str, ...]): path entries; empty refuses the
            command regardless of its operands.
        mount (str): set by the compiler for a rule written under a
            ``mounts.<prefix>`` section, the mount root it is scoped to:
            it applies only to a line whose cwd or paths lie under it.
            Empty for a rule written at the top level; never typed in
            the document.
    """

    reason: str
    commands: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()
    mount: str = ""


@dataclass(frozen=True, slots=True)
class Ask:
    """Admit the command only with a host approval.

    A pre_command answer: ``PermissionsPolicy`` returns one for a
    ``commands.ask`` rule, a custom policy for a coded condition, and
    both route to the workspace's approval door (``Approvals``). A Deny
    from any policy outranks it: the chain keeps looking past an Ask
    for a Deny, so an approval can never re-open a refusal. Command
    plane only: the op doors cannot wait on a host.

    Args:
        reason (str): why the line needs sign-off, shown to the agent
            in the requires-approval voice and to the host in the
            request.
        rule (CommandRule | None): the document rule that asked; None
            for a coded condition, for which the door keys a session
            grant on the program that asked.
    """

    kind: ClassVar[str] = "ask"

    reason: str
    rule: CommandRule | None = None


# The closed vocabulary of policy answers: a hook returns an Action to
# state an opinion or None to stay silent. Deny refuses (first opinion
# wins); Ask defers to the host (a Deny anywhere in the chain still
# wins); Limit bounds (every opinion merges to the tightest,
# Limit.aggr). Each hook accepts a fixed set of kinds (VALIDITY),
# enforced loud.
Action = Deny | Limit | Ask

# The host's answer to an approval request. ``allow_once`` admits the
# exact line one time, ``allow_session`` admits every line the rule
# covers for the rest of the session, ``deny`` refuses the retry with
# the ask's reason in the deny voice.
ApprovalDecision = Literal["allow_once", "allow_session", "deny"]

# How far a host grant reaches through ``Approvals.grant``: ``once`` is
# ``allow_once``, ``session`` is ``allow_session``.
GrantScope = Literal["once", "session"]


@dataclass(frozen=True, slots=True)
class Grant:
    """The host's standing answer to an asked line, held on the session
    until the run it answers.

    ``allow_once`` and ``deny`` answer one retry of the exact line (the
    expanded words and the cwd of the request) and are consumed by it;
    ``allow_session`` answers every line the rule covers for the rest
    of the session and stays. Session state like functions and cwd:
    persisted with the session record, read through the session
    manager so a fork or a background copy shares it, never inherited
    by another session. Consulted only after the deny rules, so a grant
    never re-opens a deny.

    Args:
        decision (ApprovalDecision): the host's answer.
        rule (CommandRule): the rule the answer is for; for a coded Ask
            the door synthesizes one over the program that asked.
        argv (tuple[str, ...]): the line as expanded, command name
            first, for the exact-line decisions.
        cwd (str): the working directory of the request.
    """

    decision: ApprovalDecision
    rule: CommandRule
    argv: tuple[str, ...]
    cwd: str


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """One asked line, as the approver sees it.

    Args:
        id (str): stable for the exact line in the session (a digest
            of session, cwd and words), so a retry asks the same
            question and the host answers it once.
        session_id (str): the session running the line.
        agent_id (str): the agent the workspace attributes the line to.
        command (str): the command name.
        argv (tuple[str, ...]): the words after the name, as expanded.
        cwd (str): the session working directory.
        paths (tuple[str, ...]): the virtual paths the line names.
        reason (str): the ask's reason.
        rule (CommandRule): the rule that asked, synthesized for a
            coded Ask.
    """

    id: str
    session_id: str
    agent_id: str
    command: str
    argv: tuple[str, ...]
    cwd: str
    paths: tuple[str, ...]
    reason: str
    rule: CommandRule


@dataclass(frozen=True, slots=True)
class Pending:
    """The door's answer while the host has not decided: the line is
    refused for now, and the id names what to grant.

    Args:
        id (str): the approval id the agent should quote.
        reason (str): the ask's reason.
    """

    id: str
    reason: str


class SessionGrantsQuery(Protocol):
    """The session questions the approval door asks.

    The SessionManager satisfies it structurally, so the door reads and
    writes a session's grants by id without this package importing the
    workspace, and always on the registered session rather than the
    fork a line may be running in.
    """

    def grants_of(self, session_id: str) -> tuple[Grant, ...]:
        """The grants a session holds, oldest first.

        Args:
            session_id (str): the session.
        """
        ...

    def set_grants(self, session_id: str, grants: tuple[Grant, ...]) -> None:
        """Replace a session's grants.

        Args:
            session_id (str): the session.
            grants (tuple[Grant, ...]): the new list.
        """
        ...

    async def flush(self) -> None:
        """Persist what changed."""
        ...


@dataclass(frozen=True, slots=True)
class AdmissionRules:
    """One role's admission rules, compiled: the whole permission
    document a session runs under.

    A session is evaluated against exactly one of these. It holds the
    role's allow list, its ask and deny rules, and the rules its mount
    entries carry, each stamped with the mount it was written under so
    it applies to a line working inside that mount. There is nothing
    above it and nothing beside it: two rules that both match are
    resolved by anchor depth, then by verb (``policy/match/decide``).

    Args:
        allow (tuple[str, ...] | None): the role's allow patterns; None
            when it states no list (everything visible).
        ask (tuple[CommandRule, ...]): rules admitted only with an
            approval.
        deny (tuple[CommandRule, ...]): rules refused with a reason.
    """

    allow: tuple[str, ...] | None = None
    ask: tuple[CommandRule, ...] = ()
    deny: tuple[CommandRule, ...] = ()


class SessionCommandsQuery(Protocol):
    """The one session question the permissions policy asks.

    The SessionManager satisfies it structurally, so the policy reads
    the layers by session id without this package importing the
    workspace.
    """

    def commands_of(self, session_id: str) -> "AdmissionRules | None":
        """The compiled admission rules of one session; the default
        role's for an id the manager does not know, the empty id of an
        unbound door included.

        Args:
            session_id (str): the session, empty when none is bound.
        """
        ...


@dataclass(frozen=True, slots=True)
class CommandContext:
    """Facts about one classified command, as pre_command hooks see it.

    Args:
        command (str): the command name.
        paths (tuple[PathSpec, ...]): every path the line names, the
            positional operands first and then the values of any
            path-valued flags. What a path-pattern guard matches on.
        operands (tuple[PathSpec, ...]): the positional operands alone.
            A rule that reads a slot by position (mv's source, ln's
            target, tar's files) has to use this: with the flag values
            mixed in, ``tar -xf a.tar -C /mnt`` would read the ``-C``
            destination as a file being archived.
        argv (tuple[str, ...]): raw argv after the command name; the
            hook fires before flag parsing, so shorthand flags are raw
            tokens.
        cwd (str): session working directory.
        registry (MountRootQuery): mount-root oracle for POSIX rules.
        session_id (str): the session running the line, set by the
            door; empty outside a workspace.
        agent_id (str): the agent the workspace attributes the line
            to, carried per execution so a nested line (``eval``,
            ``$()``, ``xargs``) and a concurrent one keep their own;
            what an approval request names.
        tokens (tuple[str, ...]): the line as an admission pattern
            reads it, command name first: for an installed CLI the
            verb path replaces the words before it (options before the
            verb dropped, an alias canonicalized), then the leaf's own
            words; for anything else the name and the raw argv.
        program (tuple[str, ...]): the head of ``tokens`` that names
            what runs: the name plus a CLI's verb path.
        tool (bool): whether the word is a tool the allow lists govern.
            The door clears it for the shell's own grammar (the
            grammar-tier builtins), the agent's own function where the
            function is what runs, and an executed path: none of those
            is tool use, so an allow list never refuses them, though a
            deny rule still can.
        walks (bool): whether the command descends its directory
            operands (``find``, ``du``, ``tree``, ``rg``, ``grep -r``,
            ``ls -R``), so a mount whose root sits under one of its
            paths is a mount the line works inside: the executor's
            fan-out reruns the traversal in each descendant mount, and
            no admission fires again there.
    """

    command: str
    paths: tuple[PathSpec, ...]
    argv: tuple[str, ...]
    cwd: str
    registry: MountRootQuery
    operands: tuple[PathSpec, ...] = ()
    session_id: str = ""
    agent_id: str = ""
    tokens: tuple[str, ...] = ()
    program: tuple[str, ...] = ()
    tool: bool = True
    walks: bool = False


@dataclass(frozen=True, slots=True)
class OpsContext:
    """Facts about one VFS op, as pre_ops hooks see it.

    Fires at the op doors (the ``ws.ops`` facade, which also serves
    FUSE, and the shell's internal dispatcher), before any backend or
    cache I/O, so it holds however the mount is reached.

    Args:
        op (str): operation name (read, write, unlink, readdir, ...).
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
        session_id (str): the session the door serves, set by the door
            from the session it already resolves for hides and modes;
            empty for the unbound host view.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    session_id: str = ""


@dataclass(frozen=True, slots=True)
class OpsResultContext:
    """One completed VFS op, as post_ops hooks see it.

    Args:
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result (bytes, FileStat, listing,
            ...); a Deny here suppresses it.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    result: Any


@dataclass(frozen=True, slots=True)
class ExecuteResultContext:
    """One finished execute() line, as post_execute hooks see it.

    Fires at the workspace boundary before the line's output stream is
    finalized, so a Limit returned here bounds what the caller sees.

    Args:
        producer (Producer): provenance of the surviving stream (the
            rightmost command, per shell semantics); a Producer with an
            empty command when no dispatch site stamped one.
        exit_code (int): the line's exit code so far.
    """

    producer: Producer
    exit_code: int


@dataclass(frozen=True, slots=True)
class SessionContext:
    """Facts about one session-state mutation, as pre_session hooks see it.

    Fires on the session plane before the write lands, so it holds
    whichever tier asked. Not an OpsContext: a session key is not a
    path, and a path-scoped policy must never receive one dressed as a
    path and match it by accident.

    Args:
        plane (str): the state plane being written (``env``).
        verb (str): the mutation (``set``, ``unset``).
        key (str): the state key (a variable name).
        value (str | None): the value being written, None for unset.
        session_id (str): which session is writing, so a policy can
            scope a rule to one agent (deny ``set`` for session X).
    """

    plane: str
    verb: str
    key: str
    value: str | None
    session_id: str = ""


VALIDITY: dict[str, frozenset[str]] = {
    "pre_command": frozenset({Deny.kind, Ask.kind}),
    "pre_ops": frozenset({Deny.kind}),
    "post_ops": frozenset({Deny.kind, Limit.kind}),
    "post_execute": frozenset({Limit.kind}),
    "pre_session": frozenset({Deny.kind}),
}
