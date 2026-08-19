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

from mirage.policy.types import DEFAULT_DENY_REASON, CommandRule
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


def _string_list(value: Any, where: str) -> tuple[str, ...]:
    """A document list field, refused unless every item is a string.

    A scalar ``commands: rm`` would otherwise ``tuple()`` into
    ``('r', 'm')`` and the command it meant to refuse stay allowed, so
    the document fails to load instead, as it does in TypeScript.

    Args:
        value (Any): the field as written, None when absent.
        where (str): the field's name, for the message.
    """
    entries = _list(value, where, "a list of strings")
    for i, entry in enumerate(entries):
        if not isinstance(entry, str):
            raise ValueError(f"{where}[{i}] must be a string")
    return entries


def _rule(entry: Any) -> Any:
    """Coerce one ``deny`` entry to a CommandRule.

    A bare string is one command name with the default reason; a
    mapping is the rule's fields, ``reason`` defaulting; anything else
    is handed back for pydantic to report.

    Args:
        entry (Any): one entry as written in the document.
    """
    if isinstance(entry, str):
        return CommandRule(reason=DEFAULT_DENY_REASON, commands=(entry, ))
    if isinstance(entry, Mapping):
        unknown = sorted(set(entry) - _RULE_FIELDS)
        if unknown:
            raise ValueError(
                f"deny rule has unknown field(s): {', '.join(unknown)}")
        reason = entry.get("reason", DEFAULT_DENY_REASON)
        if not isinstance(reason, str):
            raise ValueError("deny rule reason must be a string")
        return CommandRule(reason=reason,
                           commands=_string_list(entry.get("commands"),
                                                 "deny rule commands"),
                           paths=_string_list(entry.get("paths"),
                                              "deny rule paths"))
    return entry


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
    """``commands:`` of the workspace tier.

    ``deny`` rules refuse with a reason; a bare string is one command
    name with the default reason. ``allow`` and ``ask`` arrive with
    their enforcement.

    Args:
        deny (tuple[CommandRule, ...]): the tier's refusals, in order.
    """

    model_config = _DOC

    deny: tuple[CommandRule, ...] = ()

    @field_validator("deny", mode="before")
    @classmethod
    def _v_deny(cls, v: Any) -> Any:
        return tuple(_rule(entry) for entry in _list(v, "commands.deny"))


class MountPermissions(BaseModel):
    """``mounts.<prefix>.permissions``: mount-owned, relative to the
    mount root, binding every session.

    Args:
        paths (PathsBlock): the mount's hides, mount-relative.
    """

    model_config = _DOC

    paths: PathsBlock = PathsBlock()


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
    """

    model_config = _DOC

    extends: str | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    mounts: dict[str, MountMode] | tuple[str, ...] | None = None
    paths: PathsBlock | None = None
    vars: VarsBlock | None = None

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
    """

    mount_modes: dict[str, MountMode] | None
    hidden_paths: HiddenPaths | None
    hidden_vars: HiddenVars | None
    env: dict[str, str] | None
    cwd: str | None
