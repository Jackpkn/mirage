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

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mirage.types import EntryGate, MountMode, PathSpec, weaker_mode
from mirage.utils.hidden import path_hidden

if TYPE_CHECKING:
    from mirage.workspace.session.manager import SessionManager
    from mirage.workspace.session.session import Session


@dataclass(frozen=True, slots=True)
class SessionBinding:
    """The session bound to one async context, and whose it is.

    Args:
        session (Session | None): the live session.
        owner (SessionManager | None): the session manager the session
            belongs to, which is one per workspace. None when the
            binder did not name one.
    """
    session: "Session | None"
    owner: "SessionManager | None"


_current_session: ContextVar[SessionBinding | None] = ContextVar(
    "mirage_current_session",
    default=None,
)


def set_current_session(session: "Session | None",
                        owner: "SessionManager | None" = None) -> Token[Any]:
    """Bind ``session`` to the current async context.

    Args:
        session (Session | None): the session to bind.
        owner (SessionManager | None): the manager the session belongs
            to. None keeps the owner already bound, so a nested bind
            inside a line (a background job's fork) stays attributed to
            the workspace running it.
    """
    if owner is None:
        current = _current_session.get()
        owner = current.owner if current is not None else None
    return _current_session.set(SessionBinding(session=session, owner=owner))


def reset_current_session(token: Token[Any]) -> None:
    """Restore the previous session binding."""
    _current_session.reset(token)


def get_current_session() -> "Session | None":
    """Return the session bound to the current async context, if any."""
    binding = _current_session.get()
    return binding.session if binding is not None else None


def get_current_session_for(owner: "SessionManager") -> "Session | None":
    """Return the bound session only when ``owner`` published it.

    A session carries one workspace's cwd, env and mount grants, so a
    second workspace re-entered mid-line must resolve its own session
    rather than adopt this one.

    Args:
        owner (SessionManager): the asking workspace's session manager.
    """
    binding = _current_session.get()
    if binding is None or binding.owner is not owner:
        return None
    return binding.session


def _norm_prefix(mount_prefix: str) -> str:
    stripped = mount_prefix.strip("/")
    return "/" + stripped if stripped else "/"


def _session_mode(mount_prefix: str) -> "MountMode":
    """The current session's mode cap for this mount.

    ``MountMode.EXEC`` (no narrowing) when no session is bound, when the
    profile names no mount, or when it names none for this one: a profile's
    mount sections narrow what the mount already offers and never
    decide whether it exists. A profile that must not reach a mount hides
    it, which answers ENOENT rather than a permission error naming
    something the profile cannot see.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
    """
    sess = get_current_session()
    if sess is None or sess.mount_modes is None:
        return MountMode.EXEC
    return sess.mount_modes.get(_norm_prefix(mount_prefix), MountMode.EXEC)


def hidden_paths_active() -> bool:
    """Whether the current session hides any paths at all.

    For a summarizing fast path (du -s asks the backend for one total)
    that must not be trusted when hidden leaves could be inside it.

    Args:
        None
    """
    sess = get_current_session()
    return sess is not None and sess.hidden_paths is not None


DEFAULT_UMASK = 0o022


def session_umask() -> int:
    """The file-creation mask of the session bound to this context.

    Read by the creators that run inside a command handler (`mkdir`,
    which cannot be handed the session) the way `path_allowed` reads
    the hidden-paths spec: bash's default when no session is bound,
    which is also what mirage's own 644/755 defaults for a new entry
    already assume.

    Args:
        None
    """
    sess = get_current_session()
    return DEFAULT_UMASK if sess is None else sess.umask


def dotglob_active() -> bool:
    """Whether the bound session's `shopt -s dotglob` is on.

    Read inside pathname expansion, which runs in every backend's
    `resolve_glob` and so cannot be handed the session: bash's rule is
    that a name starting with `.` is matched only by a pattern that
    starts with `.`, and `dotglob` is the one thing that relaxes it.
    False when no session is bound, which is bash's default.

    Args:
        None
    """
    sess = get_current_session()
    return sess is not None and bool(sess.shopts.get("dotglob"))


def session_path_allowed(sess: "Session", virtual: str) -> bool:
    """Whether a session's hidden-paths specs, its own and the
    workspace-bound one, leave this path visible.

    The explicit-session form of ``path_allowed``, for a door that
    holds the session rather than running under it: the admission
    gate drops a hidden operand before any policy reads it, so a rule
    or an ask never names a path the session cannot see.

    Args:
        sess (Session): the session asking.
        virtual (str): absolute virtual path.
    """
    return not (sess.hidden_paths is not None
                and path_hidden(sess.hidden_paths, virtual))


def path_allowed(virtual: str) -> bool:
    """Whether the current session's hidden-paths specs, its own and
    the workspace-bound one, leave this path visible.

    Enumeration surfaces filter
    names through it and the doors answer ENOENT (EACCES for creates)
    when it says no, so hiding reads as nonexistence, never as a
    denial that leaks the name. True when no session is bound or the
    session hides nothing.

    Args:
        virtual (str): absolute virtual path.
    """
    sess = get_current_session()
    return sess is None or session_path_allowed(sess, virtual)


_current_admission: ContextVar["EntryGate | None"] = ContextVar(
    "mirage_current_admission",
    default=None,
)


def set_admission(gate: "EntryGate") -> Token[Any]:
    """Bind the admitted command's entry gate to the current async
    context, for the run of that one command.

    Set by the dispatcher once the gate let the command through and
    reset when the command returns, so a nested line (``xargs``,
    ``find -exec``, ``eval``) binds its own and the outer command gets
    its gate back, and a pipeline stage in its own task never sees a
    sibling's.

    Args:
        gate (EntryGate): the admitted command's gate.
    """
    return _current_admission.set(gate)


def reset_admission(token: Token[Any]) -> None:
    """Restore the previous admission binding."""
    _current_admission.reset(token)


def get_admission() -> "EntryGate | None":
    """The entry gate of the command running in this context, None
    when no admitted command is bound (a command constructed outside
    the dispatcher, or a line no gate judged)."""
    return _current_admission.get()


def path_rules_active() -> bool:
    """Whether a path rule in force reads the running command's paths.

    The twin of ``hidden_paths_active`` for the deny rules: a backend's
    native find or du classifies the raw tree, so an entry a rule
    refuses would be listed or summed past the gate; the readdir walk
    passes every entry through it instead. False when no admitted
    command is bound.

    Args:
        None
    """
    gate = get_admission()
    return gate is not None and gate.scoped


_redirect_paths: ContextVar[tuple[int, tuple[PathSpec, ...]]
                            | None] = (ContextVar("mirage_redirect_paths",
                                                  default=None))


def set_redirect_paths(node_id: int, paths: tuple[PathSpec,
                                                  ...]) -> Token[Any]:
    """Bind a statement's expanded redirect targets to the command node
    they belong to, for that node's run.

    The redirect layer expands the targets before the command executes
    (a ``$()`` in one runs exactly once there), so the admission gate
    deep in command dispatch cannot re-derive them; it reads them here
    instead. Keyed by the tree-sitter node id so a nested line expanded
    on the way to the command (a ``$()`` operand, an ``eval``) never
    inherits the outer statement's targets.

    Args:
        node_id (int): the command node the targets belong to.
        paths (tuple[PathSpec, ...]): the expanded targets.
    """
    return _redirect_paths.set((node_id, paths))


def reset_redirect_paths(token: Token[Any]) -> None:
    """Restore the previous redirect-target binding."""
    _redirect_paths.reset(token)


def redirect_paths_for(node_id: int) -> tuple[PathSpec, ...]:
    """The redirect targets bound to this command node, empty for any
    other node or when none are bound.

    Args:
        node_id (int): the command node about to be admitted.
    """
    bound = _redirect_paths.get()
    if bound is None or bound[0] != node_id:
        return ()
    return bound[1]


def redirect_target_judged(virtual: str) -> bool:
    """Whether a path is a redirect target the command door already
    judged for the statement writing it now.

    The op doors ask this, and unlike :func:`redirect_paths_for` it
    takes no node id, because by the time the shell writes the file the
    node has returned and a door sees only a path. The binding is what
    keeps that honest: it exists only while one statement's targets are
    being written, and a statement whose targets a rule refused never
    reaches the write at all. So a bound target is one the line was
    admitted with, and re-deriving a verdict for it from a door that
    knows neither the line nor the nod it holds can only get it wrong.

    Args:
        virtual (str): absolute virtual path of the op.
    """
    bound = _redirect_paths.get()
    return bound is not None and any(p.virtual == virtual for p in bound[1])


def effective_mount_mode(mount_prefix: str,
                         mount_mode: MountMode) -> MountMode:
    """The mount mode after narrowing by the current session's cap.

    The mount's own mode is the strongest one available; a profile's mode
    can only weaken it (a READ mount stays read-only whatever the profile
    says). A mount the profile does not name keeps its own mode.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
        mount_mode (MountMode): the mount's configured mode.
    """
    return weaker_mode(mount_mode, _session_mode(mount_prefix))
