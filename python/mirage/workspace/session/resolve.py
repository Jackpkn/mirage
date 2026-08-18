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

from collections.abc import Iterable, Mapping
from typing import Any

from mirage.policy.errors import PolicyError
from mirage.types import HiddenPaths, MountMode, weaker_mode
from mirage.utils.hidden import classify_paths, classify_vars
from mirage.workspace.session.permissions import (CompiledProfile,
                                                  MountPermissions, PathsBlock,
                                                  SessionProfile, VarsBlock,
                                                  WorkspacePermissions)
from mirage.workspace.session.session import Session, vars_from_env
from mirage.workspace.session.shell_dirs import set_cwd

DEFAULT_PROFILE = "default"

# The profile fields inheritance copies: a stated field replaces the
# parent's, an absent (None) one is inherited. `extends` itself is not
# a field a child inherits.
_INHERITED = ("cwd", "env", "mounts", "paths", "vars")

ProfileMounts = dict[str, MountMode] | tuple[str, ...] | None


def inherit(profiles: Mapping[str, SessionProfile],
            name: str) -> SessionProfile:
    """Resolve a named profile through its ``extends`` chain.

    Field inheritance, root first: a stated field replaces the
    parent's, an absent one is inherited. Safety comes from the layer
    intersection at evaluation, not from inheritance, so a child may
    state fewer hides than its parent. The result names no parent.

    Args:
        profiles (Mapping[str, SessionProfile]): the workspace's named
            profiles.
        name (str): the profile to resolve.

    Raises:
        PolicyError: an unknown profile name, or a cycle in the chain.
    """
    chain: list[SessionProfile] = []
    seen: list[str] = []
    current: str | None = name
    while current is not None:
        if current in seen:
            cycle = " -> ".join([*seen, current])
            raise PolicyError(f"profile extends cycle: {cycle}")
        if current not in profiles:
            where = (f"profile {seen[-1]!r} extends unknown profile"
                     if seen else "unknown profile")
            raise PolicyError(f"{where} {current!r}")
        seen.append(current)
        node = profiles[current]
        chain.append(node)
        current = node.extends
    merged: dict[str, Any] = {}
    for node in reversed(chain):
        for field_name in _INHERITED:
            value = getattr(node, field_name)
            if value is not None:
                merged[field_name] = value
    return SessionProfile.model_validate(merged)


def resolve_profile(
    profiles: Mapping[str, SessionProfile],
    profile: str | SessionProfile | None,
) -> SessionProfile | None:
    """The profile a session is created from, before inline tightening.

    A name resolves through :func:`inherit`; a profile object that
    names a parent resolves the same way with itself as the child;
    None picks ``profiles.default`` when the workspace defines one and
    leaves the session unrestricted otherwise.

    Args:
        profiles (Mapping[str, SessionProfile]): the workspace's named
            profiles.
        profile (str | SessionProfile | None): what ``create_session``
            was given.
    """
    if profile is None:
        if DEFAULT_PROFILE in profiles:
            return inherit(profiles, DEFAULT_PROFILE)
        return None
    if isinstance(profile, str):
        return inherit(profiles, profile)
    if profile.extends is None:
        return profile
    return inherit({**profiles, "": profile}, "")


def _intersect_mounts(base: ProfileMounts,
                      inline: ProfileMounts) -> ProfileMounts:
    """The mounts both sides grant, at the weaker mode.

    A mapping is a set of ceilings, a tuple an allowlist at each
    mount's own mode. Mapping x mapping: common prefixes at the weaker
    mode; mapping x tuple: the mapping's entries the list also names;
    tuple x tuple: the common prefixes; None x anything: the other.

    Args:
        base (ProfileMounts): the profile's grant.
        inline (ProfileMounts): the inline grant.
    """
    if base is None:
        return inline
    if inline is None:
        return base
    if isinstance(base, dict) and isinstance(inline, dict):
        return {
            p: weaker_mode(m, inline[p])
            for p, m in base.items() if p in inline
        }
    if isinstance(base, dict):
        return {p: m for p, m in base.items() if p in inline}
    if isinstance(inline, dict):
        return {p: m for p, m in inline.items() if p in base}
    return tuple(p for p in base if p in inline)


def _union_hide(a: PathsBlock | VarsBlock | None,
                b: PathsBlock | VarsBlock | None) -> tuple[str, ...]:
    """Every entry of both blocks, first spelling wins, order kept."""
    out: list[str] = []
    for block in (a, b):
        for entry in (block.hide if block is not None else ()):
            if entry not in out:
                out.append(entry)
    return tuple(out)


def tighten(base: SessionProfile | None,
            inline: SessionProfile | None) -> SessionProfile | None:
    """Narrow a profile by an inline document (design 3.4).

    Mounts intersect, hides union, ``cwd`` and ``env`` are the inline
    document's when it states them (they are session presets, not
    permissions). Either side None returns the other unchanged.

    Args:
        base (SessionProfile | None): the resolved profile.
        inline (SessionProfile | None): what ``create_session`` added.
    """
    if base is None:
        return inline
    if inline is None:
        return base
    hide_paths = _union_hide(base.paths, inline.paths)
    hide_vars = _union_hide(base.vars, inline.vars)
    env = None
    if base.env is not None or inline.env is not None:
        env = {**(base.env or {}), **(inline.env or {})}
    return SessionProfile(
        cwd=inline.cwd if inline.cwd is not None else base.cwd,
        env=env,
        mounts=_intersect_mounts(base.mounts, inline.mounts),
        paths=(PathsBlock(hide=hide_paths) if
               (base.paths is not None or inline.paths is not None) else None),
        vars=(VarsBlock(hide=hide_vars) if
              (base.vars is not None or inline.vars is not None) else None),
    )


def rebase(prefix: str, perms: MountPermissions | None) -> tuple[str, ...]:
    """A mount's hides in absolute terms.

    Every entry, glob or plain, is joined under the mount root, so a
    mount-relative rule can never reach outside its mount; a slashless
    glob stops being a component pattern and becomes anchored under
    the mount, which is the only reading "relative to the mount root"
    can have.

    Args:
        prefix (str): the mount prefix, any slash spelling.
        perms (MountPermissions | None): the mount's block, if any.
    """
    if perms is None:
        return ()
    root = "/" + prefix.strip("/")
    base = root.rstrip("/")
    joined = []
    for entry in perms.paths.hide:
        rel = entry.lstrip("/")
        joined.append(base + "/" + rel if rel else root)
    return tuple(joined)


def bound_hidden(
    workspace: WorkspacePermissions | None,
    mounts: Mapping[str, MountPermissions | None],
) -> HiddenPaths | None:
    """What every session of the workspace cannot see.

    The workspace tier's hides plus each mount's rebased hides,
    compiled once and stamped onto every session by the session
    manager, joined with the session's own hides in the predicate.

    Args:
        workspace (WorkspacePermissions | None): the top-level block.
        mounts (Mapping[str, MountPermissions | None]): each mount's
            block by prefix.
    """
    entries: list[str] = []
    if workspace is not None:
        entries.extend(workspace.paths.hide)
    for prefix, perms in mounts.items():
        entries.extend(rebase(prefix, perms))
    return classify_paths(entries)


def compile_profile(
    effective: SessionProfile | None, infrastructure: Iterable[str] = ()
) -> CompiledProfile:
    """The session fields an effective profile sets.

    Args:
        effective (SessionProfile | None): the resolved and tightened
            profile; None is an unrestricted session.
        infrastructure (Iterable[str]): mount prefixes every session may
            touch (the scratch root, the device mount, the history
            view); a profile that lists mounts gets them at EXEC beside
            its own so a ceiling never locks an agent out of them.
    """
    if effective is None:
        return CompiledProfile(mount_modes=None,
                               hidden_paths=None,
                               hidden_vars=None,
                               env=None,
                               cwd=None)
    modes: dict[str, MountMode] | None
    if effective.mounts is None:
        modes = None
    elif isinstance(effective.mounts, dict):
        modes = dict(effective.mounts)
    else:
        modes = {p: MountMode.EXEC for p in effective.mounts}
    if modes is not None:
        for prefix in infrastructure:
            modes.setdefault(prefix, MountMode.EXEC)
    return CompiledProfile(
        mount_modes=modes,
        hidden_paths=classify_paths(
            effective.paths.hide if effective.paths is not None else ()),
        hidden_vars=classify_vars(
            effective.vars.hide if effective.vars is not None else ()),
        env=dict(effective.env) if effective.env is not None else None,
        cwd=effective.cwd,
    )


def narrow(session: Session, compiled: CompiledProfile) -> None:
    """Stamp a compiled profile's narrowing onto a session.

    The three fields no shell line can edit: mount ceilings, hidden
    paths, hidden variables. Applied at creation and again whenever a
    stored record could carry a stale copy (the default session after
    hydration), so the document, not the store, is what an agent runs
    under.

    Args:
        session (Session): the session to narrow.
        compiled (CompiledProfile): the effective profile.
    """
    session.mount_modes = (dict(compiled.mount_modes)
                           if compiled.mount_modes is not None else None)
    session.hidden_paths = compiled.hidden_paths
    session.hidden_vars = compiled.hidden_vars


def apply_profile(session: Session, compiled: CompiledProfile) -> None:
    """Narrow a fresh session and seed its scratch state from the profile.

    A profile's env is a *process* environment, the same shape
    ``ws.env = {...}`` speaks, so every name in it is exported: seeding
    them plain left ``$TOKEN`` expanding while every command, CLI and
    guest runtime in the profiled session saw nothing, since all three
    read ``env_snapshot`` and that is the exported set. The cwd is where
    the session starts; both are the agent's to change afterwards,
    which is why hydration keeps the stored ones and re-stamps only
    :func:`narrow`.

    Args:
        session (Session): the session just created.
        compiled (CompiledProfile): the effective profile.
    """
    narrow(session, compiled)
    if compiled.env:
        session.vars.update(vars_from_env(compiled.env))
    if compiled.cwd is not None:
        set_cwd(session, compiled.cwd)
