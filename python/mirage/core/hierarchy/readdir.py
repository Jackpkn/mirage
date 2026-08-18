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

from collections.abc import Awaitable, Callable, Mapping
from typing import Literal

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hierarchy.probe import A, ReaddirFn
from mirage.core.hierarchy.scope import INVALID, ROOT, DetectFn, RouteMatch
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir
from mirage.utils.key_prefix import mount_prefix_of

Lister = Callable[[A, RouteMatch], Awaitable[list[tuple[str, IndexEntry]]]]
Guard = Callable[[A, RouteMatch, str], Awaitable[None]]


def make_readdir(
    detect: DetectFn,
    *,
    listers: Mapping[str, Lister[A]],
    static_root: tuple[str, ...] | None = None,
    guards: Mapping[str, Guard[A]] | None = None,
    leaf_error: Literal["enoent", "enotdir"] = "enoent",
) -> ReaddirFn[A]:
    """Build a hierarchy readdir: dispatch, guards, index, name joins.

    A lister fetches one directory kind and returns ``(vfs_name,
    IndexEntry)`` pairs; everything else — classification, existence
    guards, the index probe and write-back, and virtual name
    construction — happens here, identically for every backend.

    Args:
        detect (DetectFn): the backend's route classifier.
        listers (Mapping[str, Lister]): one lister per directory kind;
            include ``root`` for a dynamic mount root.
        static_root (tuple[str, ...] | None): fixed top-level names, for
            backends whose root never changes; bypasses the index.
        guards (Mapping[str, Guard]): existence checks that run before
            the index probe, so a vanished container is ENOENT even on a
            warm cache.
        leaf_error (Literal["enoent", "enotdir"]): what listing a leaf
            raises; fixed hierarchies historically answer ENOENT.
    """

    async def readdir(accessor: A,
                      path_spec: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> list[str]:
        virtual = path_spec.virtual
        prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
        path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
        key = path.strip("/")
        virtual_key = prefix + "/" + key if key else prefix or "/"
        match = detect(path)
        if match.kind == INVALID:
            raise enoent(virtual)
        if match.kind == ROOT and static_root is not None:
            return [f"{prefix}/{d}" for d in static_root]
        lister = listers.get(match.kind)
        if lister is None:
            if (match.route is not None and match.route.leaf
                    and leaf_error == "enotdir"):
                raise enotdir(virtual)
            raise enoent(virtual)
        guard = guards.get(match.kind) if guards is not None else None
        if guard is not None:
            await guard(accessor, match, virtual)
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
        entries = await lister(accessor, match)
        await index.set_dir(virtual_key, entries)
        stem = virtual_key.rstrip("/")
        return [f"{stem}/{name}" for name, _ in entries]

    return readdir
