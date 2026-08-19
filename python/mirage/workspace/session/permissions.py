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
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from mirage.policy.types import (DEFAULT_ASK_REASON, DEFAULT_DENY_REASON,
                                 CommandRule, CommandsSpec)
from mirage.types import HiddenPaths, HiddenVars, MountMode, parse_mount_mode

_DOC = ConfigDict(extra="forbid", frozen=True)

_RULE_FIELDS = frozenset({"reason", "commands", "paths"})


def _norm_prefix(prefix: str) -> str:
    """One spelling for a mount prefix: leading slash, no trailing one.

    Args:
        prefix (str): a prefix as typed in the document.
    """
    return "/" + prefix.strip("/")


def _list(value: Any, where: str, expected: str = "a list") -> tuple[Any, ...]:
    """A document list, refused before a scalar can be iterated.

    Args:
        value (Any): the field as written, None when absent.
        where (str): the field's name, for the message.
        expected (str): the expected shape named in the message.
    """
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{where} must be {expected}")
    return tuple(value)


def _string_list(value: Any,
                 where: str,
                 nonblank: bool = False) -> tuple[str, ...]:
    """A document list field, refused unless every item is a string.

    A scalar ``commands: rm`` would otherwise ``tuple()`` into
    ``('r', 'm')`` and the command it meant to refuse stay allowed, so
    the document fails to load instead, as it does in TypeScript. A
    command pattern must also hold a token: a blank one is a prefix of
    every line, so a stray ``""`` would allow, ask about or deny every
    command.

    Args:
        value (Any): the field as written, None when absent.
        where (str): the field's name, for the message.
        nonblank (bool): refuse entries with no token.
    """
    entries = _list(value, where, "a list of strings")
    for i, entry in enumerate(entries):
        if not isinstance(entry, str):
            raise ValueError(f"{where}[{i}] must be a string")
        if nonblank and not entry.split():
            raise ValueError(f"{where}[{i}] must name a command")
    return entries


def _rule(entry: Any, where: str, default_reason: str) -> Any:
    """Coerce one ``deny`` or ``ask`` entry to a CommandRule.

    A bare string is one command pattern with the arm's default
    reason; a mapping is the rule's fields, ``reason`` defaulting;
    anything else is handed back for pydantic to report.

    Args:
        entry (Any): one entry as written in the document.
        where (str): ``deny rule`` or ``ask rule``, for the messages.
        default_reason (str): the arm's reason for a rule stating none.
    """
    if isinstance(entry, str):
        return CommandRule(reason=default_reason,
                           commands=_string_list((entry, ),
                                                 f"{where} commands",
                                                 nonblank=True))
    if isinstance(entry, Mapping):
        unknown = sorted(set(entry) - _RULE_FIELDS)
        if unknown:
            raise ValueError(
                f"{where} has unknown field(s): {', '.join(unknown)}")
        reason = entry.get("reason", default_reason)
        if not isinstance(reason, str):
            raise ValueError(f"{where} reason must be a string")
        return CommandRule(reason=reason,
                           commands=_string_list(entry.get("commands"),
                                                 f"{where} commands",
                                                 nonblank=True),
                           paths=_string_list(entry.get("paths"),
                                              f"{where} paths"))
    return entry


def _rules(v: Any, where: str) -> Any:
    default = DEFAULT_ASK_REASON if where == "ask" else DEFAULT_DENY_REASON
    return tuple(
        _rule(entry, f"{where} rule", default)
        for entry in _list(v, f"commands.{where}", "a list of rules"))


def _patterns(v: Any) -> Any:
    if v is None:
        return None
    return _string_list(v, "commands.allow", nonblank=True)


class PathsBlock(BaseModel):
    """``paths:`` of one tier.

    ``hide`` entries use the document's one grammar: an entry with
    ``*``, ``?`` or ``[`` is a pattern, anything else an exact path
    and its subtree (``utils/hidden.classify_paths``). ``show`` arrives
    with its enforcement.

    Args:
        hide (tuple[str, ...]): what the tier makes nonexistent.
    """

    model_config = _DOC

    hide: tuple[str, ...] = ()


class VarsBlock(BaseModel):
    """``vars:`` of a profile.

    Args:
        hide (tuple[str, ...]): variable names or globs over names the
            session reads as unset.
    """

    model_config = _DOC

    hide: tuple[str, ...] = ()


class CommandsBlock(BaseModel):
    """``commands:`` of the workspace and profile tiers.

    ``allow`` lists the command patterns the tier installs; a name none
    of them starts with is not a command for the session (127, absent
    from ``type`` / ``which`` / ``man``), a line no pattern covers is
    refused. Grammar-tier shell builtins and the agent's own functions
    are not subjects. ``ask`` rules are admitted only with a host
    approval; ``deny`` rules refuse with a reason. A bare string in
    either is one command pattern with the default reason.

    Args:
        allow (tuple[str, ...] | None): the tier's allow patterns;
            None (unstated) installs everything.
        ask (tuple[CommandRule, ...]): what needs sign-off, in order.
        deny (tuple[CommandRule, ...]): the tier's refusals, in order.
    """

    model_config = _DOC

    allow: tuple[str, ...] | None = None
    ask: tuple[CommandRule, ...] = ()
    deny: tuple[CommandRule, ...] = ()

    @field_validator("allow", mode="before")
    @classmethod
    def _v_allow(cls, v: Any) -> Any:
        return _patterns(v)

    @field_validator("ask", mode="before")
    @classmethod
    def _v_ask(cls, v: Any) -> Any:
        return _rules(v, "ask")

    @field_validator("deny", mode="before")
    @classmethod
    def _v_deny(cls, v: Any) -> Any:
        return _rules(v, "deny")


class MountCommandsBlock(BaseModel):
    """``commands:`` of a mount tier: ``ask`` and ``deny`` only.

    A mount rule applies to a line that works inside the mount (its cwd
    or one of its paths lies under the root); its ``paths`` are
    mount-relative. There is no mount-tier ``allow``: what a session
    can see is a property of the session, and an operand cannot make a
    command "not found".

    Args:
        ask (tuple[CommandRule, ...]): what needs sign-off here.
        deny (tuple[CommandRule, ...]): what is refused here.
    """

    model_config = _DOC

    ask: tuple[CommandRule, ...] = ()
    deny: tuple[CommandRule, ...] = ()

    @field_validator("ask", mode="before")
    @classmethod
    def _v_ask(cls, v: Any) -> Any:
        return _rules(v, "ask")

    @field_validator("deny", mode="before")
    @classmethod
    def _v_deny(cls, v: Any) -> Any:
        return _rules(v, "deny")


class MountPermissions(BaseModel):
    """``mounts.<prefix>.permissions``: mount-owned, relative to the
    mount root, binding every session.

    Args:
        paths (PathsBlock): the mount's hides, mount-relative.
        commands (MountCommandsBlock): the mount's ask and deny rules.
    """

    model_config = _DOC

    paths: PathsBlock = PathsBlock()
    commands: MountCommandsBlock = MountCommandsBlock()


class WorkspacePermissions(BaseModel):
    """Top-level ``permissions:``: workspace-wide, absolute paths,
    binding every session.

    Args:
        commands (CommandsBlock): the workspace's deny rules.
        paths (PathsBlock): the workspace's hides.
    """

    model_config = _DOC

    commands: CommandsBlock = CommandsBlock()
    paths: PathsBlock = PathsBlock()


class SessionProfile(BaseModel):
    """One role's narrowing: the profile a session is created from, the
    inline document that tightens it, and the shape of both.

    Configuration, not enforcement: the resolver compiles the fields
    onto the session's own narrowing fields and the doors keep
    enforcing. A profile is a template (``extends`` is field
    inheritance: a stated field replaces the parent's, an absent one is
    inherited); safety comes from the layer intersection at
    evaluation, never from inheritance. Deliberately not named a View,
    which per the view convention is a door-scoped handle an agent
    holds, while a profile is what the embedder uses to *define* one.
    Frozen so two agents with the same role share one object and
    neither can bend the other's view. Every field is None when the
    document leaves it unsaid, which is what inheritance reads.

    Args:
        extends (str | None): the profile this one inherits from.
        cwd (str | None): the session's working directory at creation.
        env (dict[str, str] | None): a process environment seeded and
            exported into the session at creation.
        mounts (dict[str, MountMode] | tuple[str, ...] | None): a
            mapping of prefix to mode ceiling (``r`` / ``rw`` / ``rwx``
            or the mode names), or a plain list of prefixes that keeps
            each mount at its own configured mode; None leaves mounts
            unrestricted.
        paths (PathsBlock | None): the profile's hides.
        vars (VarsBlock | None): the profile's hidden variables.
        commands (CommandsBlock | None): the profile's allow list and
            ask / deny rules.
    """

    model_config = _DOC

    extends: str | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    mounts: dict[str, MountMode] | tuple[str, ...] | None = None
    paths: PathsBlock | None = None
    vars: VarsBlock | None = None
    commands: CommandsBlock | None = None

    @field_validator("mounts", mode="before")
    @classmethod
    def _v_mounts(cls, v: Any) -> Any:
        if v is None:
            return None
        if isinstance(v, str):
            return (_norm_prefix(v), )
        if isinstance(v, Mapping):
            modes: dict[str, MountMode] = {}
            for prefix, mode in v.items():
                if not isinstance(prefix, str):
                    raise ValueError("mounts keys must be strings")
                if not isinstance(mode, str):
                    raise ValueError(
                        f"mounts[{prefix}] must be a mode name or alias")
                modes[_norm_prefix(prefix)] = parse_mount_mode(mode)
            return modes
        if not isinstance(v, (list, tuple)):
            raise ValueError("mounts must be a mapping or a list of strings")
        return tuple(
            _norm_prefix(prefix) for prefix in _string_list(v, "mounts"))


@dataclass(frozen=True, slots=True)
class CompiledProfile:
    """The session fields an effective profile compiles to.

    Args:
        mount_modes (dict[str, MountMode] | None): per-mount ceilings;
            a listed prefix with no ceiling carries the mount's own
            mode as EXEC (no narrowing below the mount).
        hidden_paths (HiddenPaths | None): the profile's own hides.
        hidden_vars (HiddenVars | None): the profile's hidden variables.
        env (dict[str, str] | None): variables to seed and export.
        cwd (str | None): the working directory to start in.
        commands (CommandsSpec | None): the profile's own command
            tier, evaluated after the bound tiers.
    """

    mount_modes: dict[str, MountMode] | None
    hidden_paths: HiddenPaths | None
    hidden_vars: HiddenVars | None
    env: dict[str, str] | None
    cwd: str | None
    commands: CommandsSpec | None = None
