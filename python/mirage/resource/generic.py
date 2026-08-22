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

from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexConfig
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.ops.generic import make_generic_ops
from mirage.ops.registry import RegisteredOp
from mirage.resource.base import BaseResource
from mirage.types import PathSpec

# The direct-attribute surface a builtin backend publishes as its
# ``_ops`` class attribute, which ``BaseResource.__getattr__`` binds the
# accessor into. Keys are the builtins' own spelling rather than
# ``CommandIO``'s, because this is the vocabulary an out-of-tree caller
# already reads off ram, s3 or disk; only ``find`` and ``rm_r`` are
# spelled differently there. ``is_mounted``, ``dir_copy`` and
# ``set_attrs`` are deliberately absent: no builtin publishes them, and a
# kit backend that grew two names its builtin twin lacks would not be the
# same surface.
_DIRECT_OPS: dict[str, str] = {
    "readdir": "readdir",
    "read_bytes": "read_bytes",
    "range_read": "read_range",
    "read_stream": "read_stream",
    "stat": "stat",
    "write": "write",
    "append": "append",
    "create": "create",
    "mkdir": "mkdir",
    "unlink": "unlink",
    "rmdir": "rmdir",
    "rm_recursive": "rm_r",
    "rename": "rename",
    "copy": "copy",
    "truncate": "truncate",
    "exists": "exists",
    "find_flat": "find",
}


def direct_ops(io: CommandIO) -> dict[str, Callable[..., Any]]:
    """Map a table's core functions onto the builtin ``_ops`` names.

    A builtin sets ``_ops`` as a class attribute; a kit backend has no
    class to hang one on, so it is derived per instance from the same
    table that feeds the commands and the ops. Fields the table leaves
    None are omitted, so the surface a kit backend publishes is exactly
    what it can answer.

    Args:
        io (CommandIO): the backend's IO table.
    """
    ops: dict[str, Callable[..., Any]] = {}
    for name, field in _DIRECT_OPS.items():
        fn = getattr(io, field)
        if fn is not None:
            ops[name] = fn
    if io.du is not None:
        ops["du_size"] = io.du.size
        ops["du_entries"] = io.du.entries
    return ops


class GenericResource(BaseResource):
    """A full backend generated from one :class:`CommandIO` table.

    The one-file path for custom backends: supply an accessor and the
    core functions on a ``CommandIO`` (readdir/read_bytes/stat at
    minimum), and the whole generic command set — plus glob resolution —
    is wired automatically. Optional fields on the table unlock more
    surface (``write`` enables the byte-mutation family, ``find`` and
    ``du_size`` become native fast paths), and the escape hatches
    mirror what builtin backends use: ``overrides`` suppresses generic
    commands the backend replaces, ``commands`` appends bespoke
    ``@command`` verbs, and ``ops`` registers ``@op`` handlers for FUSE
    and os-interception mounts.

    Args:
        name (str): resource name commands register under; also the
            registry key when the class is exposed via
            ``register_resource`` or a ``mirage.resources`` entry point.
        accessor (Accessor): backend handle passed to every core fn.
        io (CommandIO): the backend's IO table.
        prompt (str): LLM-facing description of the mounted layout.
        write_prompt (str): appended when mounted writable.
        overrides (set[str] | None): generic command names the backend
            replaces (pass the replacements via ``commands``).
        commands (list[Callable] | None): extra ``@command``-decorated
            functions (bespoke verbs or override replacements).
        ops (list[Callable] | None): ``@op``-decorated functions or
            ``RegisteredOp`` instances for VFS/FUSE dispatch, layered
            over (and shadowing same-named entries of) the auto-derived
            set.
        auto_ops (bool): derive the VFS/FUSE op set from the table via
            ``make_generic_ops`` (read/readdir/stat plus whatever
            mutations the table carries); disable to register only
            explicit ``ops``.
        provision_overrides (dict[str, Callable] | None): per-command
            cost estimators replacing the catalog default.
        caches_reads (bool): serve repeat reads from the file cache;
            enable only for stable, read-mostly content.
        sizes_always_known (bool): whether ``io.stat`` sizes every
            regular file without fetching it. A backend that renders its
            content on read leaves this False and rides the unknown-size
            machinery; a byte store sets it, which is also what makes the
            mount legal on FSKit.
        supports_snapshot (bool): whether ``io.stat`` fills
            ``FileStat.fingerprint`` with a stable per-path version
            marker. Setting it without that is not drift detection, it is
            a snapshot that claims to have one.
        index (IndexConfig | None): cache-index configuration.
    """

    def __init__(
        self,
        *,
        name: str,
        accessor: Accessor,
        io: CommandIO,
        prompt: str = "",
        write_prompt: str = "",
        overrides: set[str] | None = None,
        commands: list[Callable[..., Any]] | None = None,
        ops: list[Callable[..., Any]] | None = None,
        provision_overrides: dict[str, Callable[..., Any]] | None = None,
        auto_ops: bool = True,
        caches_reads: bool = False,
        sizes_always_known: bool = False,
        supports_snapshot: bool = False,
        index: IndexConfig | None = None,
    ) -> None:
        super().__init__(index=index)
        if not name:
            raise ValueError("GenericResource requires a non-empty name")
        self.name = name
        self.accessor = accessor
        self.io = io
        self.PROMPT = prompt
        self.WRITE_PROMPT = write_prompt
        self.caches_reads = caches_reads
        self.SIZES_ALWAYS_KNOWN = sizes_always_known
        self.SUPPORTS_SNAPSHOT = supports_snapshot
        self._resolve = io.resolve_glob
        self._ops = direct_ops(io)
        for fn in make_generic_commands(
                name,
                io,
                overrides=overrides,
                provision_overrides=provision_overrides):
            self.register(fn)
        for fn in commands or []:
            self.register(fn)
        user_ops: list[RegisteredOp] = []
        for fn in ops or []:
            if isinstance(fn, RegisteredOp):
                user_ops.append(fn)
            else:
                user_ops.extend(getattr(fn, "_registered_ops"))
        if auto_ops:
            shadowed = {ro.name for ro in user_ops if ro.filetype is None}
            for ro in make_generic_ops(name, io, overrides=shadowed):
                self.register_op(ro)
        for ro in user_ops:
            self.register_op(ro)

    async def resolve_glob(self,
                           paths: list[Any],
                           prefix: str = "") -> list[PathSpec]:
        return await self._resolve(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        # ``needs_override`` is inert for python's own loader, which
        # rebuilds the class from ``type`` through the registry. It is
        # written for a TypeScript reader, whose ``buildMountArgs``
        # consults no registry and would otherwise restore this mount as
        # an empty RAMResource; the builtins carrying the key do so for
        # the same reason.
        return {"type": self.name, "needs_override": True}
