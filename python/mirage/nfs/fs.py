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
import errno
import os
import posixpath

from mirage.mount.platform.macos import is_macos_metadata
from mirage.nfs.config import NFSConfig
from mirage.nfs.errors import StaleHandleError
from mirage.nfs.ids import ROOT_PATH, IdTable
from mirage.nfs.types import DirEntry, NFSAttrs, SetAttrs
from mirage.nfs.writebuf import WriteBuffer
from mirage.ops import Ops
from mirage.types import FileStat, FileType
from mirage.utils.stat_view import mtime_ns


def _join(parent: str, name: str) -> str:
    return posixpath.join(parent,
                          name) if parent != ROOT_PATH else ROOT_PATH + name


def _epoch(stat: FileStat) -> float:
    """Modification time in seconds since the epoch, or 0 when unknown.

    The wire needs an ``nfstime3``, and a backend that cannot date a
    file leaves the client reading 1970 -- which is honest, and is why
    this is one conversion rather than a fabricated "now".

    Args:
        stat (FileStat): the row to read the time from.

    Returns:
        float: seconds since the epoch, 0.0 when the row has no time.
    """
    stamp = mtime_ns(stat)
    return 0.0 if stamp is None else stamp / 1_000_000_000


class MirageNFS:
    """The NFSv3 filesystem the server crate calls back into.

    One method per trait callback, each one async so it runs on the
    workspace event loop and reaches the op door the same way a shell
    command does: mount grants, admission policies, cache and namespace
    all fire once, at that door. The adapter itself owns only what the
    protocol needs and mirage does not have -- which file id names which
    path, and the writes a client has sent but not yet had stored.

    Paths crossing this boundary are mount-relative; the mount prefix is
    applied by the op facade this is constructed with.
    """

    def __init__(self, ops: Ops, config: NFSConfig | None = None) -> None:
        self._ops = ops
        self._config = config or NFSConfig()
        self._ids = IdTable()
        self._writes = WriteBuffer()
        # One lock per file that has been written; dropped with the
        # buffer it guards, so the table tracks live files rather than
        # every id ever minted.
        self._flush_locks: dict[int, asyncio.Lock] = {}
        self._root = self._ids.alloc(ROOT_PATH)

    def root_dir(self) -> int:
        """The file id of the export root."""
        return self._root

    async def lookup(self, dirid: int, name: str) -> int:
        """Resolve a name inside a directory to a file id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the entry name.

        Returns:
            int: the entry's file id.

        Raises:
            StaleHandleError: the parent id is unknown.
            FileNotFoundError: no such entry.
        """
        if is_macos_metadata(name):
            # Finder and Spotlight probe these on every listing;
            # answering here keeps the probe off the backend, exactly
            # as MountCore.getattr does.
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                                    name)
        path = _join(self._ids.resolve(dirid), name)
        if self._link_target(path) is None:
            await self._ops.stat(path)
        return self._ids.alloc(path)

    async def getattr(self, fileid: int) -> NFSAttrs:
        """Attributes for a file id, counting writes not yet stored.

        Args:
            fileid (int): the file to stat.

        Returns:
            NFSAttrs: the shape the Rust layer converts to fattr3.
        """
        return await self._entry_attrs(fileid, self._ids.resolve(fileid))

    async def read(self, fileid: int, offset: int, count: int) -> bytes:
        """Read through any writes still buffered for this file.

        Args:
            fileid (int): the file to read.
            offset (int): where the read starts.
            count (int): how many bytes the client asked for.

        Returns:
            bytes: the slice, short at end of file.
        """
        path = self._ids.resolve(fileid)
        base = await self._read_base(path)
        return self._writes.overlay(fileid, base, offset, count)

    async def write(self, fileid: int, offset: int, data: bytes) -> NFSAttrs:
        """Buffer a write and answer with the size the client expects.

        The bytes are stored on flush, not here: this server answers
        every write as durable and never forwards a COMMIT, so the
        adapter batches and bounds the window itself.

        Args:
            fileid (int): the file being written.
            offset (int): byte offset the client wrote at.
            data (bytes): the payload.

        Returns:
            NFSAttrs: post-write attributes, with the extended size.
        """
        path = self._ids.resolve(fileid)
        full = self._writes.append(fileid,
                                   offset,
                                   data,
                                   max_bytes=self._config.max_buffered_bytes)
        if full:
            await self._flush_one(fileid, path)
        stat = await self._ops.stat(path)
        return self._attrs(fileid, stat)

    async def create(self, dirid: int, name: str) -> int:
        """Create an empty file and return its id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the new file's name.

        Returns:
            int: the new file's id.
        """
        path = _join(self._ids.resolve(dirid), name)
        await self._ops.create(path)
        return self._ids.alloc(path)

    async def mkdir(self, dirid: int, name: str) -> int:
        """Create a directory and return its id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the new directory's name.

        Returns:
            int: the new directory's id.
        """
        path = _join(self._ids.resolve(dirid), name)
        await self._ops.mkdir(path)
        return self._ids.alloc(path)

    async def remove(self, dirid: int, name: str) -> None:
        """Remove a file or directory.

        The server routes both REMOVE and RMDIR here, so the entry is
        stat-ed first to pick the right op. Buffered writes are dropped
        rather than flushed: storing them would bring the file back.

        Args:
            dirid (int): the parent directory's id.
            name (str): the entry to remove.
        """
        path = _join(self._ids.resolve(dirid), name)
        fileid = self._ids.id_for(path)
        if self._link_target(path) is not None:
            # The entry itself is a link, so it is unlinked whatever it
            # points at: stat would follow it, and following a link to
            # a directory would rmdir the target instead of the link.
            # The door special-cases the unlink of a link, so no stat
            # is needed -- which is also what lets a broken link be
            # removed at all.
            if fileid is not None:
                self._writes.drop(fileid)
                self._flush_locks.pop(fileid, None)
            await self._ops.unlink(path)
            if fileid is not None:
                self._ids.invalidate(fileid)
            return
        stat = await self._ops.stat(path)
        if fileid is not None:
            self._writes.drop(fileid)
            self._flush_locks.pop(fileid, None)
        if stat.type == FileType.DIRECTORY:
            await self._ops.rmdir(path)
        else:
            await self._ops.unlink(path)
        if fileid is not None:
            self._ids.invalidate(fileid)

    async def rename(self, from_dirid: int, from_name: str, to_dirid: int,
                     to_name: str) -> None:
        """Move an entry, carrying its id and pending writes with it.

        Pending writes are flushed to the old path first: they were
        acknowledged against it, and flushing after the move would merge
        them onto whatever now lives at the destination.

        Args:
            from_dirid (int): source directory id.
            from_name (str): source entry name.
            to_dirid (int): destination directory id.
            to_name (str): destination entry name.

        Raises:
            OSError: EINVAL when the destination lies inside the
                source, refused before the backend is touched.
        """
        src = _join(self._ids.resolve(from_dirid), from_name)
        dst = _join(self._ids.resolve(to_dirid), to_name)
        self._ids.guard_rename(src, dst)
        fileid = self._ids.id_for(src)
        if fileid is not None and self._writes.has_pending(fileid):
            await self._flush_one(fileid, src)
        await self._ops.rename(src, dst)
        self._ids.rename(src, dst)

    async def setattr(self, fileid: int, attrs: SetAttrs) -> NFSAttrs:
        """Apply the one settable attribute: size.

        mode, uid, gid and the timestamps are accepted and discarded,
        exactly as the FUSE adapter does -- a mirage backend has nowhere
        to persist them, and refusing would fail ordinary tools.

        Args:
            fileid (int): the file to change.
            attrs (SetAttrs): requested change; only ``size`` acts.

        Returns:
            NFSAttrs: attributes after the change.
        """
        path = self._ids.resolve(fileid)
        size = attrs.size
        if size is not None:
            self._writes.clip(fileid, size)
            await self._ops.truncate(path, size)
        stat = await self._ops.stat(path)
        return self._attrs(fileid, stat)

    async def set_size(self, fileid: int, size: int | None) -> NFSAttrs:
        """The wire layer's SETATTR entry point, on primitives.

        The Rust boundary crosses on primitives, so it calls this
        rather than constructing a :class:`SetAttrs`.

        Args:
            fileid (int): the file to change.
            size (int | None): new length, or None when the request
                carried no size and everything is discarded.

        Returns:
            NFSAttrs: attributes after the change.
        """
        return await self.setattr(fileid, SetAttrs(size=size))

    async def symlink(self, dirid: int, name: str, target: str) -> int:
        """Create a symlink and return its id.

        Args:
            dirid (int): the parent directory's id.
            name (str): the link's name.
            target (str): what the link points at, stored verbatim.

        Returns:
            int: the link's file id.
        """
        path = _join(self._ids.resolve(dirid), name)
        await self._ops.symlink(path, target)
        return self._ids.alloc(path)

    async def readlink(self, fileid: int) -> str:
        """The target a symlink holds.

        Args:
            fileid (int): the link's file id.

        Returns:
            str: the target as the client should see it -- relative
            targets verbatim, absolute ones rewritten relative to the
            link's directory, since an absolute target names a virtual
            path the client would otherwise resolve against its own
            root and escape the mount.

        Raises:
            OSError: EINVAL when the id does not name a link.
        """
        path = self._ids.resolve(fileid)
        target = self._link_target(path)
        if target is None:
            raise OSError(errno.EINVAL, os.strerror(errno.EINVAL), path)
        return target

    async def readdir(self,
                      dirid: int,
                      cookie: int = 0,
                      max_entries: int | None = None) -> list[DirEntry]:
        """List a directory, resuming after the entry ``cookie`` names.

        The cookie is the last-seen entry's fileid: the server crate
        derives the wire cookie from each entry's id and hands it back
        as ``start_after``. Resume keys on identity, never on comparing
        magnitudes -- ids are minted in access order, so a later entry
        may carry a smaller id than an earlier one.

        Args:
            dirid (int): the directory to list.
            cookie (int): fileid of the last entry seen; 0 starts at
                the top.
            max_entries (int | None): cap on entries returned.

        Returns:
            list[DirEntry]: name, fileid, cookie and attributes, with
            ``cookie == fileid`` on every entry.
        """
        path = self._ids.resolve(dirid)
        # The facade answers in paths -- a child mount with a trailing
        # slash -- so names are derived the way MountCore.readdir does,
        # and macOS metadata names are dropped the same way.
        found = set()
        for entry in await self._ops.readdir(path):
            part = entry.rstrip("/").rsplit("/", 1)[-1]
            if part and not is_macos_metadata(part):
                found.add(part)
        names = sorted(found)
        entries: list[DirEntry] = []
        resuming = cookie != 0
        for name in names:
            child = _join(path, name)
            fileid = self._ids.alloc(child)
            if resuming:
                if fileid == cookie:
                    resuming = False
                continue
            entries.append(
                DirEntry(name=name,
                         fileid=fileid,
                         cookie=fileid,
                         attrs=await self._entry_attrs(fileid, child)))
            if max_entries is not None and len(entries) >= max_entries:
                break
        return entries

    async def flush(self, fileid: int) -> None:
        """Store one file's buffered writes.

        Args:
            fileid (int): the file to flush.
        """
        if self._writes.has_pending(fileid):
            await self._flush_one(fileid, self._ids.resolve(fileid))

    async def flush_all(self) -> None:
        """Store every buffered write.

        Used by the idle sweep and at teardown. A file id that went
        stale under a pending buffer is dropped rather than raised: one
        dead entry must not stop the rest from being stored.
        """
        for fileid in self._writes.pending_ids():
            await self._flush_or_drop(fileid)

    async def flush_idle(self) -> None:
        """Store writes untouched for longer than the idle window."""
        for fileid in self._writes.idle_ids(self._config.idle_flush_seconds):
            await self._flush_or_drop(fileid)

    async def _flush_or_drop(self, fileid: int) -> None:
        """Flush one file id, discarding its writes if the id went stale.

        A sweep covers every buffered id, so one entry whose path is
        gone must not stop the others from being stored.

        Args:
            fileid (int): the file to flush.
        """
        try:
            path = self._ids.resolve(fileid)
        except StaleHandleError:
            self._writes.drop(fileid)
            self._flush_locks.pop(fileid, None)
            return
        await self._flush_one(fileid, path)

    def _flush_lock(self, fileid: int) -> asyncio.Lock:
        """The lock serializing one file's flushes.

        Kept here rather than on ``WriteBuffer``: the state holders are
        await-free by design, and a lock inside one would not help
        anyway -- what has to be atomic spans a read, a take and a
        write, which only the caller can bracket.

        Args:
            fileid (int): the file whose flushes to serialize.

        Returns:
            asyncio.Lock: the lock for that file.
        """
        lock = self._flush_locks.get(fileid)
        if lock is None:
            lock = asyncio.Lock()
            self._flush_locks[fileid] = lock
        return lock

    async def _flush_one(self, fileid: int, path: str) -> None:
        """Store one file's buffered writes, one flush at a time.

        Read, take and write are one critical section. Without it two
        flushes of the same file -- an idle timer against a size
        trigger, or either against teardown -- each read the same stored
        base and take different batches, and whichever store lands last
        drops the other batch. The client was told those bytes were
        durable.

        Args:
            fileid (int): the file to flush.
            path (str): its path, resolved by the caller.
        """
        async with self._flush_lock(fileid):
            base = await self._read_base(path)
            pending = self._writes.take(fileid)
            if not pending:
                return
            await self._ops.write(path, WriteBuffer.merge(base, pending))

    async def _read_base(self, path: str) -> bytes:
        try:
            return await self._ops.read(path, raw=True)
        except (FileNotFoundError, IsADirectoryError):
            return b""

    def _link_target(self, path: str) -> str | None:
        """The target to present for a namespace link, None otherwise.

        The link check must precede any ops stat, exactly as in
        ``MountCore.getattr``: the op facade follows namespace links,
        so a stat on a link path reports the target and the link
        itself becomes invisible. Relative targets are stored verbatim
        and returned as-is; absolute targets name virtual paths and are
        rewritten relative to the link's directory.

        Args:
            path (str): mount-relative path to inspect.
        """
        links = self._ops.links
        if links is None:
            return None
        target = links.readlink(path)
        if target is None:
            return None
        if not target.startswith("/"):
            return target
        parent = path.rsplit("/", 1)[0] or "/"
        return posixpath.relpath(target, parent)

    async def _entry_attrs(self, fileid: int, path: str) -> NFSAttrs:
        """Attributes for one entry, seeing a link as itself.

        Args:
            fileid (int): the entry's id.
            path (str): the entry's mount-relative path.
        """
        target = self._link_target(path)
        if target is not None:
            return NFSAttrs(fileid=fileid,
                            size=len(target.encode()),
                            is_dir=False,
                            is_symlink=True)
        return self._attrs(fileid, await self._ops.stat(path))

    def _attrs(self, fileid: int, stat: FileStat) -> NFSAttrs:
        is_dir = stat.type == FileType.DIRECTORY
        size = 0 if is_dir else self._writes.pending_size(
            fileid, stat.size or 0)
        return NFSAttrs(fileid=fileid,
                        size=size,
                        is_dir=is_dir,
                        is_symlink=stat.type == FileType.SYMLINK,
                        mode=stat.mode,
                        mtime_epoch=_epoch(stat))
