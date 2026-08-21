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

import errno
import os
import time
from datetime import datetime
from typing import Any

from mirage.cache.file import io as cache_io
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.utils.limit import apply_op_limit
from mirage.context import get_current_session, path_allowed
from mirage.io import IOResult, OpReport
from mirage.observe.context import record
from mirage.observe.record import OpRecord
from mirage.ops.config import NO_FOLLOW_OPS, STAMP_WRITE_OPS
from mirage.ops.namespace_view import (merge_readdir, namespace_listing,
                                       namespace_stat)
from mirage.policy import post_ops_gate, pre_ops_gate
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.types import ConsistencyPolicy, FileStat, PathSpec, ResourceName
from mirage.utils.errors import MISS_ERRORS, no_mount
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import owner_prefix
from mirage.utils.ranges import slice_window
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.reconcile import Reconciler
from mirage.workspace.snapshot.drift import DriftQueue

from mirage.workspace.dispatcher.constants import (  # isort: skip
    DISPATCH_READ_OPS, DISPATCH_WRITE_OPS, HIDDEN_CREATE_OPS, LINK_ENTRY_OPS,
    NAMESPACE_TABLE_OPS, POLICY_WRITE_OPS, SETATTR_KEYS)


def _memory_answered(report: OpReport | None,
                     moved: int | None = None) -> None:
    """Stamp the caller's report: memory answered, no backend ran.

    Fires at the moment a warm file-cache hit or a synthetic namespace
    answer is in hand, before the post gate and any output cap, so
    whatever those raise cannot erase the fact. The value is
    ``ResourceName.RAM``, which is how a record says "this never
    crossed the network": ``OpRecord.is_cache`` is defined as that
    string, and every network/cache total derives from it.

    Args:
        report (OpReport | None): the caller's report, None when the
            caller does not observe ops.
        moved (int | None): bytes memory served, None when the result
            is the measure.
    """
    if report is not None:
        report.served(ResourceName.RAM.value, moved)


def _hidden_refusal(op: str, virtual: str) -> OSError:
    """The error a hidden path answers: ENOENT, or EACCES for a create.

    Args:
        op (str): the dispatched op name.
        virtual (str): the hidden virtual path.
    """
    if op in HIDDEN_CREATE_OPS:
        return PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                               virtual)
    return FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), virtual)


def _visible_entries(entries: list[str], parent: str) -> list[str]:
    """Drop listing entries the current session's spec hides.

    Entry shapes vary by backend (bare names, trailing-slash names,
    full paths), so each is keyed by its final segment against the
    listed directory, the same normalization ``merge_readdir`` dedups
    by.

    Args:
        entries (list[str]): the merged listing.
        parent (str): the directory that was listed, as a virtual path.
    """
    base = parent.rstrip("/")
    return [
        e for e in entries
        if path_allowed(f"{base}/{e.rstrip('/').rsplit('/', 1)[-1]}")
    ]


def _session_id() -> str:
    """The id of the session this door serves, empty for the unbound
    host view; the same binding the hides and modes above read.
    """
    sess = get_current_session()
    return sess.session_id if sess is not None else ""


def _window(kwargs: dict[str, Any]) -> tuple[int, int | None]:
    """The byte window a read asked for, whole file when it asked none.

    Args:
        kwargs (dict[str, Any]): the op's keyword arguments.
    """
    offset = kwargs.get("offset")
    size = kwargs.get("size")
    return (offset if isinstance(offset, int) else 0,
            size if isinstance(size, int) else None)


class Dispatcher:
    """Route a single VFS op to its mount and keep the file cache + index
    consistent.

    Owns the cache/IO coordination that used to live on Workspace: cache
    lookups for read-caching backends, post-write file-cache eviction,
    and parent index invalidation. Constructed with the namespace (for
    addressing), cache store, and consistency policy; holds no other
    workspace state. The snapshot drift queue rides along because this
    is the one door: a strict restore's pending fingerprint checks must
    run before ANY op can touch a mount, and FUSE and the ops facade
    reach here without passing Workspace.dispatch.
    """

    def __init__(self,
                 namespace: Namespace,
                 cache,
                 consistency: ConsistencyPolicy,
                 drift: DriftQueue | None = None) -> None:
        self._namespace = namespace
        self._cache = cache
        self._reconciler = Reconciler(cache, namespace, consistency)
        self._drift = drift

    @property
    def reconciler(self) -> Reconciler:
        return self._reconciler

    def _namespace_result(self, op: str,
                          virtual: str) -> list[str] | FileStat | None:
        """The namespace's own answer for a path no backend serves.

        Child mounts and symlinks are structure the door owns, so a
        directory that exists only because a mount or link sits below it
        still lists and stats. None for any other op, or when the
        namespace knows nothing at ``virtual``.

        Args:
            op (str): the dispatched op name.
            virtual (str): the virtual path being answered.
        """
        prefixes = [m.prefix for m in self._namespace.registry.mounts()]
        if op == "readdir":
            return namespace_listing(prefixes, self._namespace, virtual)
        if op == "stat":
            return namespace_stat(prefixes, self._namespace, virtual)
        return None

    async def _gated_namespace(self, op: str, path: PathSpec,
                               fallback: "list[str] | FileStat",
                               report: OpReport | None) -> Any:
        """Gate a namespace-served answer exactly like a backend one.

        The answer has no owning prefix (the gates see ""), but
        admission still fires: a policy that bounds readdir or stat by
        path must cover the synthetic answer too.

        Args:
            op (str): the dispatched op name.
            path (PathSpec): the op's path scope.
            fallback (list[str] | FileStat): the namespace's answer.
            report (OpReport | None): the caller's report, stamped when
                the answer is in hand.
        """
        policies = self._namespace.registry.policies
        write = op in POLICY_WRITE_OPS
        # A pre gate refuses before the answer exists, so it is not a
        # completed op and stays before the stamp.
        await pre_ops_gate(policies, op, path, write, "", _session_id())
        _memory_answered(report)
        if op == "readdir" and isinstance(fallback, list):
            fallback = _visible_entries(fallback, path.virtual)
        bound = await post_ops_gate(policies, op, path, write, "", fallback)
        if bound is not None:
            return await apply_op_limit(fallback, bound)
        return fallback

    async def dispatch(self,
                       op: str,
                       path: PathSpec,
                       *,
                       report: OpReport | None = None,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        await self._namespace.ensure_loaded()
        # Pending fingerprint checks from a strict snapshot restore run
        # before the op can touch a mount, whichever surface called:
        # FUSE and the ops facade come straight here, so a drain that
        # lived any higher would let a first write clobber drifted
        # state. drain() clears pending before it stats, so its own
        # probes cannot recurse into it.
        if self._drift is not None and self._drift.pending:
            await self._drift.drain(self._namespace.registry.try_mount_for)
        # Hidden paths answer before anything else can: the typed path
        # is checked so a link inside hidden space cannot be followed
        # out of it, the followed path is re-checked so a visible link
        # cannot lead in, and a rename destination is a create.
        if not path_allowed(path.virtual):
            raise _hidden_refusal(op, path.virtual)
        dst = kwargs.get("dst")
        if (op == "rename" and isinstance(dst, PathSpec)
                and not path_allowed(dst.virtual)):
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                                  dst.virtual)
        if self._table_answers(op, path.virtual, kwargs):
            return (await self._namespace_table_op(op, path, kwargs,
                                                   report), IOResult())
        # `nofollow` is the caller's AT_SYMLINK_NOFOLLOW: an op that acts
        # on a link entry itself (chown -h writing the link's own attrs)
        # keeps the typed path. Consumed here, never forwarded.
        if op not in NO_FOLLOW_OPS and not kwargs.pop("nofollow", False):
            followed = self._namespace.follow(path.virtual)
            if followed != path.virtual:
                path = PathSpec.from_str_path(followed)
                if not path_allowed(path.virtual):
                    raise _hidden_refusal(op, path.virtual)
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            # No mount serves the path, but the namespace may still know
            # a directory there (a deeper mount, a link). No mount means
            # no cache to keep straight. The merged names are
            # session-filtered individually. A setattr lands in the
            # overlay (a link above every mount still takes chown -h),
            # gated exactly like the mounted overlay write.
            if op == "setattr":
                policies = self._namespace.registry.policies
                await pre_ops_gate(policies, op, path, True, "", _session_id())
                applied = await self._overlay_setattr(path, kwargs)
                _memory_answered(report)
                await post_ops_gate(policies, op, path, True, "", applied)
                return applied, IOResult()
            fallback = self._namespace_result(op, path.virtual)
            if fallback is None:
                raise no_mount(path.virtual)
            return (await self._gated_namespace(op, path, fallback,
                                                report), IOResult())
        # Admission policies fire at the door, before the warm-cache
        # early return below: a cached read must be refused exactly
        # like a cold one, or the cache becomes a policy bypass.
        policies = self._namespace.registry.policies
        write = op in POLICY_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, mount.prefix,
                           _session_id())
        # A rename's destination is a create there: it passes the same
        # gate as the source, so a path rule holds against moving into
        # a protected scope (or onto the directory that holds one) the
        # way it holds against writing there.
        if op == "rename" and isinstance(dst, PathSpec):
            await pre_ops_gate(policies, op, dst, True, mount.prefix,
                               _session_id())
        caches_reads = mount.resource.caches_reads
        # The file cache is keyed on the path alone, and what a command
        # put there is the rendered read. A raw read asks for a
        # different value under the same key, so it must not be served
        # from that cache; nothing populates it from here, so skipping
        # the probe is the whole fix.
        raw = "filetype" in kwargs and kwargs["filetype"] is None

        if caches_reads and not raw and op in DISPATCH_READ_OPS:
            cached = await self._cache.get(path.virtual)
            if cached is not None and await self._reconciler.may_serve_cached(
                    mount, path.virtual):
                # The cache holds the whole object, so a ranged read is
                # answered by slicing it, never by handing back the
                # whole file: the window is what the caller asked for
                # instead of the file, and git reads pack indexes this
                # way. slice_window is the same helper the ranged read
                # op falls back to, so warm and cold agree.
                offset, size = _window(kwargs)
                served = slice_window(cached, offset, size)
                # Nothing crossed the network, and neither a gate nor a
                # hard cap leaves the caller able to tell: without the
                # stamp a refused warm read is recorded against the
                # backend and counted as traffic that never happened.
                _memory_answered(report, len(served))
                bound = await post_ops_gate(policies, op, path, write,
                                            mount.prefix, served)
                if bound is not None:
                    served = await apply_op_limit(served, bound)
                return served, IOResult(reads={path.virtual: served})

        if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
            # Ops.rename addresses both endpoints against the source's
            # mount; mirror that here so the backend sees a
            # mount-relative destination.
            dst = kwargs["dst"]
            kwargs["dst"] = PathSpec(
                virtual=dst.virtual,
                directory=dst.virtual.rsplit("/", 1)[0] or "/",
                resource_path=mount_key(dst.virtual, mount.prefix.rstrip("/")),
            )
        # execute_op answers Any (each op has its own shape), and the
        # setattr fork narrows the first assignment to its dict, so the
        # local keeps the op contract's type explicitly.
        result: Any
        try:
            if op == "setattr":
                result = await self._apply_setattr(mount, path, kwargs)
            else:
                result = await mount.execute_op(op, path.virtual, **kwargs)
        except FileNotFoundError:
            result = self._namespace_result(op, path.virtual)
            if result is None:
                await self._reconciler.on_op_missing(op, path.virtual)
                raise
            _memory_answered(report)
        else:
            # The op ran, whatever invalidation, the post gate, or an
            # output cap do next: stamped here so a failure in any of
            # them cannot erase a transfer the backend already made.
            if report is not None:
                report.served(
                    None,
                    len(result) if isinstance(result,
                                              (bytes, bytearray)) else None)
        if op == "readdir":
            result = _visible_entries(
                merge_readdir(
                    result,
                    [m.prefix for m in self._namespace.registry.mounts()],
                    self._namespace, path.virtual), path.virtual)
        if op == "stat" and isinstance(result, FileStat):
            result = merge_overlay_stat(self._namespace.meta_for(path.virtual),
                                        result)
        if op in DISPATCH_WRITE_OPS:
            observed = time.time() if op in STAMP_WRITE_OPS else None
            await self.invalidate_after_write(mount, path, observed=observed)
            if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
                await self.invalidate_after_write(mount, kwargs["dst"])
                # rename(2) replaces the destination, so a node the
                # table holds at that name does not survive the move.
                # A link left there shadowed the file that had just
                # landed: the listing showed the new file, every read
                # followed the old link, and the moved content was
                # reachable under no name at all.
                await self._namespace.unlink(kwargs["dst"].virtual)
        bound = await post_ops_gate(policies, op, path, write, mount.prefix,
                                    result)
        if bound is not None:
            # The transfer already happened, so the limit changes what
            # the caller receives, not what the backend moved; the
            # report above already carries the moved count.
            result = await apply_op_limit(result, bound)
        return result, IOResult()

    def _table_answers(self, op: str, virtual: str, kwargs: dict[str,
                                                                 Any]) -> bool:
        """Whether the node table answers this op instead of a backend.

        ``symlink`` and ``readlink`` always, because a link exists
        nowhere else. The rest only when the path itself is a link, and
        then for the same reason the create and the read are the door's:
        forwarding reaches a backend that has never heard of the name.
        A no-follow stat is the read half of that fact (lstat asks for
        the link's own row, which only the table holds); a following
        stat never arrives here, since the follow above rewrote it to
        the target.

        Args:
            op (str): the dispatched op name.
            virtual (str): the op's virtual path.
            kwargs (dict[str, Any]): the op's arguments, read for the
                caller's ``nofollow``.
        """
        if op in NAMESPACE_TABLE_OPS:
            return True
        if op not in LINK_ENTRY_OPS:
            return False
        if op == "stat" and not kwargs.get("nofollow"):
            return False
        return self._namespace.is_link(virtual)

    async def _namespace_table_op(self, op: str, path: PathSpec,
                                  kwargs: dict[str, Any],
                                  report: OpReport | None) -> Any:
        """Answer a node-table op at the door itself, gated like a backend.

        A symlink is namespace state with no backend behind it, so the
        door owns every verb that names one. Admission still fires
        exactly as for a backend write: the link's turf is the longest
        mount prefix above it (the same ownership rule ``_link_allowed``
        reads for), session grants and both gates run, and the write
        leaves an OpRecord — a scoped kernel mount refuses exactly like
        a scoped shell. A link above every mount is bare namespace
        structure and clears the gates with an empty prefix.

        Args:
            op (str): ``symlink`` or ``readlink``, or the ``unlink``,
                ``rename`` or no-follow ``stat`` of a path the node
                table holds a link for.
            path (PathSpec): the link's own path, never followed.
            kwargs (dict[str, Any]): op arguments (``target`` for
                symlink, ``dst`` for rename).
            report (OpReport | None): the caller's report, stamped when
                the answer is in hand.
        """
        start = int(time.monotonic() * 1000)
        owner = owner_prefix(
            (m.prefix for m in self._namespace.registry.mounts()),
            path.virtual)
        policies = self._namespace.registry.policies
        write = op in POLICY_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, owner or "",
                           _session_id())
        result: str | FileStat | None = None
        if op == "unlink":
            target = self._namespace.readlink(path.virtual) or ""
            await self._namespace.unlink(path.virtual)
        elif op == "rename":
            target = self._namespace.readlink(path.virtual) or ""
            dst = kwargs["dst"]
            # The destination is a create there, gated like the source,
            # the way the backend path gates both ends of a rename. It
            # is then replaced as rename(2) replaces it: any node the
            # table holds at that name (a link, an attr overlay) goes.
            await pre_ops_gate(policies, op, dst, True, owner or "",
                               _session_id())
            await self._namespace.unlink(dst.virtual)
            await self._namespace.rename(path.virtual, dst.virtual)
        elif op == "symlink":
            target = str(kwargs["target"])
            # symlink(2) refuses an occupied name, and the door is the
            # only place that can tell: the node table sees a link, and
            # a probe sees the file or directory a backend holds. Left
            # unchecked, the new node shadowed live data (the bytes
            # stayed, the name read as a link) and could bury a mount
            # root, which is the one name a deployment configured.
            if await self._path_present(path):
                raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST),
                                      path.virtual)
            await self._namespace.symlink(path.virtual, target, time.time())
        elif op == "stat":
            row = self._namespace.link_stat_at(path.virtual)
            if row is None:
                raise FileNotFoundError(errno.ENOENT,
                                        os.strerror(errno.ENOENT),
                                        path.virtual)
            target = self._namespace.readlink(path.virtual) or ""
            result = row
        else:
            found = self._namespace.readlink(path.virtual)
            if found is None:
                raise await self._readlink_miss(path)
            target = found
            result = found
        record(op, path.virtual, ResourceName.RAM.value,
               len(target.encode("utf-8")), start)
        _memory_answered(report)
        bound = await post_ops_gate(policies, op, path, write, owner or "",
                                    result)
        if bound is not None:
            return await apply_op_limit(result, bound)
        return result

    async def _readlink_miss(self, path: PathSpec) -> OSError:
        """The error a readlink of something that is not a link answers.

        readlink(2) splits the two misses and callers read them
        differently: a path that is there but is not a link is EINVAL,
        and one that is not there at all is ENOENT, which is the code a
        guest's ``except FileNotFoundError`` catches. The node table
        only knows the first half, so absence is probed here and only
        here, on the failure path, where one extra round trip buys the
        right errno.

        Args:
            path (PathSpec): the path the readlink named.
        """
        if await self._path_present(path):
            return OSError(errno.EINVAL, os.strerror(errno.EINVAL),
                           path.virtual)
        return FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                                 path.virtual)

    async def _path_present(self, path: PathSpec) -> bool:
        """Whether anything at all is at `path`, on every channel.

        Absence takes both channels a backend can answer on: on a prefix
        store a directory is not an object but the set of keys under it,
        so ``stat`` misses what ``readdir`` would list, and a listing
        has to be non-empty to count because those stores answer a
        missing prefix with ``[]``. The namespace is asked first, since a
        link, and a directory that exists only because a mount or a link
        sits below it, are structure no backend can see. Mirrors
        ``resolve_path_stat``, which cannot be reused here: it dispatches,
        and the door is what dispatch is inside of.

        Args:
            path (PathSpec): the path to probe.
        """
        if self._namespace.is_link(path.virtual):
            return True
        prefixes = [m.prefix for m in self._namespace.registry.mounts()]
        if namespace_stat(prefixes, self._namespace, path.virtual) is not None:
            return True
        mount = self._namespace.try_mount_for(path.virtual)
        if mount is None:
            return False
        try:
            if await self._probe_op("stat", mount, path) is not None:
                return True
            return bool(await self._probe_op("readdir", mount, path))
        except (PolicyError, PolicyDenied):
            # A channel that refuses to answer is not evidence of
            # absence. Reporting "present" keeps the answer at the EINVAL
            # every miss gave before the split, which asserts nothing the
            # policy is withholding; reporting absence would assert a
            # fact this door was not allowed to check.
            return True

    async def _probe_op(self, op: str, mount: MountEntry,
                        path: PathSpec) -> Any:
        """Run one read op for a probe, or None when it found nothing.

        The probe reads on the caller's behalf but not at its request, so
        it passes the same admission gate the op would at the door: a
        policy that denies ``stat`` must not be reachable through a
        readlink. That refusal is raised, not swallowed, because only the
        caller knows what to answer when a channel goes dark.

        Args:
            op (str): ``stat`` or ``readdir``.
            mount (MountEntry): the mount owning the path.
            path (PathSpec): the path to probe.
        """
        if not mount.supports_op(op, path.virtual):
            return None
        await pre_ops_gate(self._namespace.registry.policies, op, path, False,
                           mount.prefix, _session_id())
        try:
            return await mount.execute_op(op, path.virtual)
        except MISS_ERRORS:
            # The "nothing here" set exactly: a miss on one channel is
            # not absence on its own, so the caller tries the other.
            return None

    async def _apply_setattr(self, mount: MountEntry, path: PathSpec,
                             kwargs: dict[str, Any]) -> dict[str, Any]:
        """Apply attributes natively where the backend can, overlay the rest.

        A mount with a native setattr op applies what it can and returns
        the residual; residual fields go to the overlay and natively
        applied ones are dropped from it, so a stale overlay never
        shadows a fresh backend value. A mount without the op, and a
        link path (which has no backend inode), overlay everything. The
        overlay half is the door's own write, so it runs inside the same
        gates as the native half.

        Args:
            mount (MountEntry): the mount owning the path.
            path (PathSpec): target path.
            kwargs (dict[str, Any]): the requested attribute fields.
        """
        requested = {key: kwargs.get(key) for key in SETATTR_KEYS}
        if (self._namespace.is_link(path.virtual)
                or not mount.supports_op("setattr", path.virtual)):
            return await self._overlay_setattr(path, kwargs)
        residual = await mount.execute_op("setattr", path.virtual, **kwargs)
        applied = [
            key for key, value in requested.items()
            if value is not None and key not in residual
        ]
        if applied:
            await self._namespace.drop_attrs(path.virtual, applied)
        if residual:
            await self._write_overlay(path.virtual, residual)
        return dict(residual)

    async def _overlay_setattr(self, path: PathSpec,
                               kwargs: dict[str, Any]) -> dict[str, Any]:
        """Store every requested field in the namespace overlay.

        Args:
            path (PathSpec): target path.
            kwargs (dict[str, Any]): the requested attribute fields.
        """
        start = int(time.monotonic() * 1000)
        overlay = {
            key: value
            for key in SETATTR_KEYS if (value := kwargs.get(key)) is not None
        }
        await self._write_overlay(path.virtual, overlay)
        record("setattr", path.virtual, ResourceName.RAM.value, 0, start)
        return overlay

    async def _write_overlay(self, virtual: str, fields: dict[str,
                                                              Any]) -> None:
        """Write one overlay entry, converting an ISO mtime to epoch.

        Args:
            virtual (str): absolute virtual path.
            fields (dict[str, Any]): attribute fields to store.
        """
        mtime = fields.get("mtime")
        if isinstance(mtime, str):
            mtime = datetime.fromisoformat(mtime).timestamp()
        await self._namespace.set_attrs(virtual,
                                        mode=fields.get("mode"),
                                        uid=fields.get("uid"),
                                        gid=fields.get("gid"),
                                        atime=fields.get("atime"),
                                        mtime=mtime)

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=True)
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=False)
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    async def apply_io(self,
                       io: IOResult,
                       records: list[OpRecord] | None = None) -> None:
        await cache_io.apply_io(self._cache,
                                io,
                                self.is_cacheable_path,
                                records=records)

    def is_cacheable_path(self, path: str) -> bool:
        mount = self._namespace.try_mount_for(path)
        if mount is None:
            return False
        return mount.resource.caches_reads

    async def invalidate_all_after_remote(self) -> None:
        """Drop the file cache and every mount index wholesale.

        A whole-line runtime may have written anywhere in its view of
        the workspace, so per-path invalidation cannot apply: clear
        the read caches so the next local command refetches from the
        backends instead of serving pre-line state.

        Example: `cat /data/x` caches "old" locally; `python3 job.py`
        runs in the sandbox and writes "new" straight to S3 via its own
        FUSE mount, which the local dispatch never saw; without this
        reset the next `cat /data/x` would serve the stale "old".
        """
        if self._cache is not None:
            await self._cache.clear()
        for mount in self._namespace.registry.mounts():
            await mount.resource.index.clear()

    async def invalidate_after_write(self,
                                     mount: MountEntry,
                                     path: PathSpec,
                                     observed: float | None = None) -> None:
        await self._namespace.clear_times(path.virtual, observed=observed)
        manager = mount.cache_manager
        if manager is None:
            manager = CacheManager(self._cache, mount.resource.index,
                                   mount.prefix, mount.resource.caches_reads)
        await manager.invalidate_after_write(path)
        await manager.invalidate_ancestors(path)
