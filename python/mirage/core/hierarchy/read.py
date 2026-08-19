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
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import DetectFn, ScopeMatch
from mirage.types import PathSpec
from mirage.utils.errors import enoent

Reader = Callable[[A, ScopeMatch, PathSpec, IndexCacheStore], Awaitable[bytes]]

WindowedReader = Callable[
    [A, ScopeMatch, PathSpec, IndexCacheStore, int | None, int | None],
    Awaitable[bytes]]


def make_read(
    detect: DetectFn,
    readers: Mapping[str, Reader[A]],
    *,
    windowed: Mapping[str, WindowedReader[A]] | None = None,
) -> Callable[..., Awaitable[bytes]]:
    """Build a hierarchy read: classify, dispatch, refuse the rest.

    Readers own their fetches, guards and rendering; the kit owns the
    classification and the ENOENT funnel for every non-file shape.

    Args:
        detect (DetectFn): the backend's scope classifier.
        readers (Mapping[str, Reader]): one reader per leaf kind.
        windowed (Mapping[str, WindowedReader]): readers for kinds whose
            content is windowed at the source (postgres rows take a row
            limit/offset the backend pushes into the query); they receive
            the caller's ``limit``/``offset``, which every plain reader
            ignores, matching a filesystem read that has no row notion.
    """

    windows = windowed if windowed is not None else {}

    async def read(accessor: A,
                   path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX,
                   *,
                   limit: int | None = None,
                   offset: int | None = None) -> bytes:
        match = detect(path)
        window = windows.get(match.kind)
        if window is not None:
            return await window(accessor, match, path, index, limit, offset)
        reader = readers.get(match.kind)
        if reader is None:
            raise enoent(path.virtual)
        return await reader(accessor, match, path, index)

    return read
