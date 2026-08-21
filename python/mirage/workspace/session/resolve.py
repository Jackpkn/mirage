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

from mirage.policy.errors import PolicyError
from mirage.policy.types import AdmissionRules, CommandRule
from mirage.types import HiddenPaths, MountMode, weaker_mode
from mirage.utils.hidden import classify_paths, classify_vars
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.session import Session, vars_from_env
from mirage.workspace.session.shell_dirs import set_cwd

from mirage.workspace.session.permissions import (  # isort: skip
    CommandsBlock, CompiledProfile, MountCommandsBlock, PathsBlock,
    ProfileMount, SessionProfile, VarsBlock)


def resolve_profile(
    profiles: Mapping[str, SessionProfile],
    profile: str | SessionProfile | None,
) -> SessionProfile | None:
    """The role a session is created from.

    A name is looked up as written; a profile object is itself; None
    picks ``profiles.default`` when the workspace defines one and
    leaves the session unrestricted otherwise. There is no inheritance
    chain: a role is the whole document, so nothing is assembled from
    somewhere else before it is read.

    Args:
        profiles (Mapping[str, SessionProfile]): the workspace's named
            roles.
        profile (str | SessionProfile | None): what ``create_session``
            was given.

    Raises:
        PolicyError: the name is not a role the workspace defines.
    """
    if profile is None:
        return profiles.get(DEFAULT_PROFILE)
    if not isinstance(profile, str):
        return profile
    if profile not in profiles:
        raise PolicyError(f"unknown profile {profile!r}")
    return profiles[profile]


def _union_hide(a: PathsBlock | VarsBlock | None,
                b: PathsBlock | VarsBlock | None) -> tuple[str, ...]:
    """Every entry of both blocks, first spelling wins, order kept.

    Args:
        a (PathsBlock | VarsBlock | None): the role's block.
        b (PathsBlock | VarsBlock | None): the inline block.
    """
    out: list[str] = []
    for block in (a, b):
        for entry in (block.hide if block is not None else ()):
            if entry not in out:
                out.append(entry)
    return tuple(out)


def refuse_allow(inline: CommandsBlock | None) -> None:
    """Refuse an allow list in an inline document.

    The refusal belongs to *where the document was written*, not to
    whether a role happened to resolve, so both paths into
    ``with_inline`` run it: a workspace with no default role must not
    quietly accept a list a workspace with one refuses.

    Args:
        inline (CommandsBlock | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list.
    """
    if inline is not None and inline.allow is not None:
        raise PolicyError("inline permissions may add ask and deny rules, "
                          "not an allow list")


def _add_commands(base: CommandsBlock | None,
                  inline: CommandsBlock | None) -> CommandsBlock | None:
    """The role's commands block with the inline document's rules added.

    An inline document may only restrict, so it carries ask and deny
    rules and never an allow list: a list there would install a command
    the role does not have, which is the one thing a per-call document
    must not do.

    Args:
        base (CommandsBlock | None): the role's block.
        inline (CommandsBlock | None): what ``create_session`` added.

    Raises:
        PolicyError: the inline document states an allow list.
    """
    if inline is None:
        return base
    refuse_allow(inline)
    if base is None:
        return inline
    return CommandsBlock(allow=base.allow,
                         ask=base.ask + inline.ask,
                         deny=base.deny + inline.deny)


def _add_mount(base: ProfileMount | None,
               inline: ProfileMount | None) -> ProfileMount:
    """One mount's entry with the inline document's added: the weaker
    mode, both rule lists, both hide lists.

    Args:
        base (ProfileMount | None): the role's entry, None when it
            names no settings for this mount.
        inline (ProfileMount | None): the inline entry.
    """
    if base is None:
        return inline if inline is not None else ProfileMount()
    if inline is None:
        return base
    mode = base.mode
    if inline.mode is not None:
        mode = (inline.mode if mode is None else weaker_mode(
            mode, inline.mode))
    ask = _rules_of(base.commands, "ask") + _rules_of(inline.commands, "ask")
    deny = _rules_of(base.commands, "deny") + _rules_of(
        inline.commands, "deny")
    hide = _union_hide(base.paths, inline.paths)
    return ProfileMount(mode=mode,
                        commands=(MountCommandsBlock(ask=ask, deny=deny) if
                                  (ask or deny) else None),
                        paths=PathsBlock(hide=hide) if hide else None)


def _rules_of(block: MountCommandsBlock | None,
              verb: str) -> tuple[CommandRule, ...]:
    """One verb's rules in a mount entry's commands block, empty when
    unstated.

    Args:
        block (MountCommandsBlock | None): the entry's block.
        verb (str): ``ask`` or ``deny``.
    """
    if block is None:
        return ()
    return block.ask if verb == "ask" else block.deny


def with_inline(base: SessionProfile | None,
                inline: SessionProfile | None) -> SessionProfile | None:
    """A role with the inline document of one ``create_session`` added.

    The one rule about combining two documents: an inline document may
    add ask and deny rules and hides, never an allow list, and that
    holds even when there is no role to add to. Modes take the weaker
    of the two, ``cwd`` and ``env`` are the inline document's when it
    states them (they are session presets, not permissions). Either
    side None returns the other unchanged.

    Args:
        base (SessionProfile | None): the resolved role.
        inline (SessionProfile | None): what ``create_session`` added.
    """
    if inline is None:
        return base
    refuse_allow(inline.commands)
    if base is None:
        return inline
    hide_paths = _union_hide(base.paths, inline.paths)
    hide_vars = _union_hide(base.vars, inline.vars)
    env = None
    if base.env is not None or inline.env is not None:
        env = {**(base.env or {}), **(inline.env or {})}
    mounts: dict[str, ProfileMount] | None = None
    if base.mounts is not None or inline.mounts is not None:
        prefixes = [*(base.mounts or {})]
        prefixes.extend(p for p in (inline.mounts or {}) if p not in prefixes)
        mounts = {
            prefix:
            _add_mount((base.mounts or {}).get(prefix), (inline.mounts
                                                         or {}).get(prefix))
            for prefix in prefixes
        }
    return SessionProfile(
        cwd=inline.cwd if inline.cwd is not None else base.cwd,
        env=env,
        mounts=mounts,
        paths=(PathsBlock(hide=hide_paths) if
               (base.paths is not None or inline.paths is not None) else None),
        vars=(VarsBlock(hide=hide_vars) if
              (base.vars is not None or inline.vars is not None) else None),
        commands=_add_commands(base.commands, inline.commands),
    )


def _root_of(prefix: str) -> str:
    """One spelling for a mount prefix: leading slash, no trailing one.

    Args:
        prefix (str): the prefix as the document spells it.
    """
    return "/" + prefix.strip("/")


def _anchored(entries: tuple[str, ...], root: str) -> tuple[str, ...]:
    """A mount section's path entries, anchored to the mount they are
    written under.

    An absolute entry already names something inside the root
    (``_under_mount`` refuses one that does not) and is left as written.
    A name pattern (``*.pem``, no slash) anchors nothing, and both
    places a mount section's entries are read from have lost the
    section by then: the session's hidden set is one list for every
    mount, and the op door matches a rule's paths without consulting
    ``rule.mount``. Left raw, ``mounts./repo.paths.hide: ["*.pem"]``
    hid ``/other/key.pem`` too, and a path-only deny under ``/repo``
    refused a read of it. The dialect's ``*`` crosses ``/``, so
    ``/repo/*.pem`` is every ``.pem`` at any depth below ``/repo`` and
    nothing outside it; anchoring also gives the entry the mount's own
    anchor depth, which is what it was always worth.

    Args:
        entries (tuple[str, ...]): the entries as written.
        root (str): the mount root, leading slash, no trailing one.
    """
    return tuple(e if e.startswith("/") else f"{root.rstrip('/')}/{e}"
                 for e in entries)


def _scoped_rules(rules: tuple[CommandRule, ...],
                  root: str) -> tuple[CommandRule, ...]:
    """A mount entry's rules, stamped with the mount they belong to and
    anchored to it.

    The stamp is what makes the rule apply to a line that *works
    inside* the mount, by cwd or by operand, which a path-scoped rule
    cannot express. The anchor is for the entries the stamp cannot
    reach: the op door reads a rule's paths alone (:func:`_anchored`).

    Args:
        rules (tuple[CommandRule, ...]): the rules as written.
        root (str): the mount prefix, leading slash, no trailing one.
    """
    return tuple(
        CommandRule(reason=rule.reason,
                    commands=rule.commands,
                    paths=_anchored(rule.paths, root),
                    mount=root) for rule in rules)


def compile_commands(profile: SessionProfile) -> AdmissionRules | None:
    """A role's admission rules: its own, plus every mount entry's,
    in one list; None when the role states none.

    Mount rules come first so the entry closest to the data speaks
    first when several rules match at the same anchor depth and only
    the message differs.

    Args:
        profile (SessionProfile): the resolved role.
    """
    ask: list[CommandRule] = []
    deny: list[CommandRule] = []
    for prefix, entry in (profile.mounts or {}).items():
        root = _root_of(prefix)
        ask.extend(_scoped_rules(_rules_of(entry.commands, "ask"), root))
        deny.extend(_scoped_rules(_rules_of(entry.commands, "deny"), root))
    block = profile.commands
    allow = block.allow if block is not None else None
    if block is not None:
        ask.extend(block.ask)
        deny.extend(block.deny)
    if allow is None and not ask and not deny:
        return None
    return AdmissionRules(allow=allow, ask=tuple(ask), deny=tuple(deny))


def _hidden(profile: SessionProfile) -> HiddenPaths | None:
    """Every path the role hides: its own entries, and each mount
    entry's anchored to the mount it was written under, since the set
    is one list for the whole session and nothing in it remembers which
    section an entry came from (:func:`_anchored`).

    Args:
        profile (SessionProfile): the resolved role.
    """
    entries: list[str] = []
    if profile.paths is not None:
        entries.extend(profile.paths.hide)
    for prefix, entry in (profile.mounts or {}).items():
        if entry.paths is not None:
            entries.extend(_anchored(entry.paths.hide, _root_of(prefix)))
    return classify_paths(entries)


def _modes(profile: SessionProfile) -> dict[str, MountMode] | None:
    """The mode each mount section states, None when none does.

    A mount the role does not name is absent from the map and keeps
    the mode it declares in the workspace's ``mounts:``; the map only
    narrows, it never grants.

    Args:
        profile (SessionProfile): the resolved role.
    """
    modes = {
        prefix: entry.mode
        for prefix, entry in (profile.mounts or {}).items()
        if entry.mode is not None
    }
    return modes or None


def compile_profile(effective: SessionProfile | None) -> CompiledProfile:
    """The session fields a role compiles to.

    Args:
        effective (SessionProfile | None): the resolved role with any
            inline document already added; None is an unrestricted
            session.
    """
    if effective is None:
        return CompiledProfile(mount_modes=None,
                               hidden_paths=None,
                               hidden_vars=None,
                               env=None,
                               cwd=None,
                               commands=None)
    return CompiledProfile(
        mount_modes=_modes(effective),
        hidden_paths=_hidden(effective),
        hidden_vars=classify_vars(
            effective.vars.hide if effective.vars is not None else ()),
        env=dict(effective.env) if effective.env is not None else None,
        cwd=effective.cwd,
        commands=compile_commands(effective),
    )


def narrow(session: Session, compiled: CompiledProfile) -> None:
    """Stamp a compiled role's narrowing onto a session.

    The four fields no shell line can edit: the per-mount modes, hidden
    paths, hidden variables, the admission rules. Applied at creation
    and again whenever a stored record could carry a stale copy (the
    default session after hydration), so the document, not the store,
    is what an agent runs under.

    Args:
        session (Session): the session to narrow.
        compiled (CompiledProfile): the effective role.
    """
    session.mount_modes = (dict(compiled.mount_modes)
                           if compiled.mount_modes is not None else None)
    session.hidden_paths = compiled.hidden_paths
    session.hidden_vars = compiled.hidden_vars
    session.commands = compiled.commands


def apply_profile(session: Session, compiled: CompiledProfile) -> None:
    """Narrow a fresh session and seed its scratch state from the role.

    A role's env is a *process* environment, the same shape
    ``ws.env = {...}`` speaks, so every name in it is exported: seeding
    them plain left ``$TOKEN`` expanding while every command, CLI and
    guest runtime in the profiled session saw nothing, since all three
    read ``env_snapshot`` and that is the exported set. The cwd is where
    the session starts; both are the agent's to change afterwards,
    which is why hydration keeps the stored ones and re-stamps only
    :func:`narrow`.

    Args:
        session (Session): the session just created.
        compiled (CompiledProfile): the effective role.
    """
    narrow(session, compiled)
    if compiled.env:
        session.vars.update(vars_from_env(compiled.env))
    if compiled.cwd is not None:
        set_cwd(session, compiled.cwd)
