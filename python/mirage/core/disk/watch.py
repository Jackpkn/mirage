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

import asyncio
import os
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.timeutil import epoch_to_iso
from mirage.types import (FileChangeKind, FileEvent, JsonValue, PathSpec,
                          WalkEntry)
from mirage.utils.fingerprint import stat_fingerprint
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook, EventHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.events import event_at, text_field

_DISK_KINDS = {
    "created": FileChangeKind.CREATE,
    "modified": FileChangeKind.UPDATE,
    "deleted": FileChangeKind.DELETE,
}


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


def _reraise(error: OSError) -> None:
    """Fail the walk on a directory it could not read.

    ``os.walk`` swallows every listing error by default, which for a
    snapshot differ means an unreadable subtree is indistinguishable
    from an empty one: it diffs into a DELETE for every child, then a
    CREATE for each when access comes back. Absence is the one error
    that is genuinely a DELETE, and the caller drops it.

    Args:
        error (OSError): The failure ``os.walk`` was about to discard.
    """
    raise error


def _walk_sync(root: Path,
               path: str) -> list[tuple[str, bool, str | None, int | None]]:
    """Collect (mount-relative path, is_dir, mtime, size) under a path.

    Runs in a worker thread; ``os.walk`` and ``stat`` are blocking.
    Symlinks are not followed, matching every other disk walk in the
    repo and keeping a link loop from hanging the poll.

    Args:
        root (Path): Mount root on the local filesystem.
        path (str): Mount-relative directory to walk.
    """
    start = _resolve(root, path)
    out: list[tuple[str, bool, str | None, int | None]] = []
    for dirpath, dirnames, filenames in os.walk(start, onerror=_reraise):
        current = Path(dirpath)
        for name in dirnames:
            relative = (current / name).relative_to(root).as_posix()
            out.append(("/" + relative, True, None, None))
        for name in filenames:
            full = current / name
            relative = full.relative_to(root).as_posix()
            try:
                info = full.lstat()
            except FileNotFoundError:
                # Same rule one entry down: a file that vanished between
                # the listing and the stat is a DELETE the next pull
                # reports, an unreadable one is not.
                continue
            out.append(("/" + relative, False, epoch_to_iso(info.st_mtime),
                        info.st_size))
    return out


class DiskWalk:
    """Recursive ``os.walk`` feeding the generic listing differ.

    Reads the filesystem directly, never through mirage's caches, as
    the DeltaHook contract requires. Fingerprints on mtime, the same
    value ``disk`` stat reports, so an editor that rewrites identical
    bytes still registers as an UPDATE. That is the local filesystem's
    own resolution, not a mirage choice: nothing cheaper than hashing
    every file can tell those two apart.
    """

    def __init__(self, accessor: DiskAccessor) -> None:
        """Args:
            accessor (DiskAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        prefix = mount_prefix_of(root.virtual, root.resource_path)
        try:
            found = await asyncio.to_thread(_walk_sync, self._accessor.root,
                                            root.mount_path)
        except FileNotFoundError:
            return
        for relative, is_dir, modified, size in found:
            virtual = (prefix.rstrip("/") + relative if prefix else relative)
            if is_dir:
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=stat_fingerprint(None, modified, size),
                            size=size,
                            modified=modified)


def build_delta_hook(accessor: DiskAccessor) -> DeltaHook:
    """Build the disk delta hook.

    Args:
        accessor (DiskAccessor): Backend handle.
    """
    return ListingDeltaHook(DiskWalk(accessor))


class DiskEventHook:
    """Map one local filesystem notification onto mount paths.

    Mirage runs no watcher of its own: the consumer owns the inotify /
    FSEvents / ReadDirectoryChangesW loop (watchdog, chokidar, or the
    raw syscall) and forwards what it saw, which keeps the dependency
    out of the package and lets a deployment pick its own mechanism.

    ``event_type`` is one of ``created``, ``modified``, ``deleted`` or
    ``moved``, so a consumer translates its library's spelling once
    (watchdog's ``created``/``modified``/``deleted``/``moved`` already
    match; chokidar's ``add``/``addDir`` are ``created``, ``unlink``/
    ``unlinkDir`` are ``deleted``, ``change`` is ``modified``). Any
    other name maps to nothing, because a watcher reports events this
    mount has no opinion about.

    ``payload`` carries the host absolute paths the event named:
    ``{"src_path": ..., "dest_path": ..., "is_directory": ...}``. Those
    are watchdog's own field names, taken verbatim from
    ``FileSystemEvent`` so a consumer can forward an event as a dict
    without renaming anything.
    """

    def __init__(self, accessor: DiskAccessor) -> None:
        """Args:
            accessor (DiskAccessor): Backend handle, read for its root.
        """
        self._accessor = accessor

    def _relative(self, host_path: str) -> str | None:
        """Mount-relative form of a host path, or None if outside.

        A watcher may be rooted above the mount, so an event for a
        sibling directory is not this mount's to report.

        Args:
            host_path (str): Absolute path on the local filesystem.
        """
        try:
            relative = Path(host_path).relative_to(
                self._accessor.root).as_posix()
        except ValueError:
            return None
        # `relative_to` spells "the root itself" as ".", which would
        # render as a fabricated "<mount>/." entry.
        return "/" if relative == "." else "/" + relative

    async def to_events(self, root: PathSpec, event_type: str,
                        payload: JsonValue) -> Sequence[FileEvent]:
        """Map one filesystem notification to the change it implies.

        A directory's own ``modified`` stays an UPDATE rather than
        becoming UNKNOWN: inotify raises it whenever a child appears or
        vanishes, and it also delivers that child's own event, so
        re-inventorying the subtree on every write inside a directory
        would throw away the whole cache for no new information.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): ``created``, ``modified``, ``deleted`` or
                ``moved``.
            payload (JsonValue): ``src_path`` plus, for a move,
                ``dest_path``.
        """
        source = text_field(payload, "src_path")
        target = text_field(payload, "dest_path")
        if event_type == "moved":
            return self._moved(root, source, target)
        if source is None:
            return ()
        relative = self._relative(source)
        if relative is None:
            return ()
        kind = _DISK_KINDS.get(event_type)
        if kind is None:
            return ()
        return (event_at(root, relative, kind), )

    def _moved(self, root: PathSpec, source: str | None,
               target: str | None) -> Sequence[FileEvent]:
        """Map a rename, which may cross the mount boundary either way.

        A watcher rooted above the mount sees renames that only half
        belong here, and each half has to be reported on its own terms:
        a move out is a DELETE of the vacated path, and a move in is a
        CREATE of the arrival. Reporting neither (which discarding the
        event on an out-of-mount source does) leaves a file sitting in
        the mount that no listing knows about.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            source (str | None): Host path the entry left, if named.
            target (str | None): Host path the entry arrived at, if named.
        """
        moved_from = self._relative(source) if source is not None else None
        moved_to = self._relative(target) if target is not None else None
        if moved_to is None:
            if moved_from is None:
                return ()
            return (event_at(root, moved_from, FileChangeKind.DELETE), )
        if moved_from is None:
            return (event_at(root, moved_to, FileChangeKind.CREATE), )
        return (event_at(root, moved_to, FileChangeKind.MOVE, moved_from), )


def build_event_hook(accessor: DiskAccessor) -> EventHook:
    """Build the disk event hook.

    Args:
        accessor (DiskAccessor): Backend handle.
    """
    return DiskEventHook(accessor)
