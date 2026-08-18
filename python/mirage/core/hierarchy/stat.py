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

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.probe import (A, ReaddirFn, assert_listed,
                                         listed_size)
from mirage.core.hierarchy.readdir import Guard
from mirage.core.hierarchy.scope import ROOT, DetectFn, RouteMatch
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent

ExtraFn = Callable[[RouteMatch], dict[str, str]]
StatHook = Callable[[A, RouteMatch, PathSpec, IndexCacheStore],
                    Awaitable[FileStat]]


def make_stat(
    detect: DetectFn,
    readdir: ReaddirFn[A],
    *,
    guards: Mapping[str, Guard[A]] | None = None,
    extras: Mapping[str, ExtraFn] | None = None,
    overrides: Mapping[str, StatHook[A]] | None = None,
) -> Callable[..., Awaitable[FileStat]]:
    """Build a hierarchy stat: existence probes and shapes per route.

    Directories answer as themselves once proven to exist; leaves prove
    existence through their parent's listing and pick up any size that
    listing recorded. A guard replaces the parent-listing probe for
    kinds whose existence the API answers directly; an override replaces
    the whole shape for kinds with bespoke stats.

    Args:
        detect (DetectFn): the backend's route classifier.
        readdir (ReaddirFn): the backend's readdir, for the
            parent-listing probe.
        guards (Mapping[str, Guard]): per-kind existence checks used
            instead of the parent listing.
        extras (Mapping[str, ExtraFn]): per-kind ``FileStat.extra``
            payloads derived from the captures.
        overrides (Mapping[str, StatHook]): per-kind full replacements.
    """

    async def stat(accessor: A,
                   path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX) -> FileStat:
        virtual = path.virtual
        match = detect(path)
        if match.kind == ROOT:
            return FileStat(name="/", type=FileType.DIRECTORY)
        route = match.route
        if route is None:
            raise enoent(virtual)
        override = (overrides.get(match.kind)
                    if overrides is not None else None)
        if override is not None:
            return await override(accessor, match, path, index)
        guard = guards.get(match.kind) if guards is not None else None
        if guard is not None:
            await guard(accessor, match, virtual)
        elif route.probed:
            await assert_listed(readdir, accessor, path, index)
        name = path.resource_path.strip("/").split("/")[-1]
        extra_fn = extras.get(match.kind) if extras is not None else None
        extra = extra_fn(match) if extra_fn is not None else {}
        if not route.leaf:
            return FileStat(name=name, type=FileType.DIRECTORY, extra=extra)
        return FileStat(
            name=name,
            type=route.filetype
            if route.filetype is not None else FileType.JSON,
            size=await listed_size(index, path),
            extra=extra,
        )

    return stat
