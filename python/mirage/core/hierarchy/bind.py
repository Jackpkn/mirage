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
from typing import TypeVar
from weakref import WeakKeyDictionary

from mirage.accessor.base import Accessor
from mirage.core.hierarchy.probe import A

T = TypeVar("T")


def per_accessor(build: Callable[[A], T]) -> Callable[[A], T]:
    """Cache one built value per accessor, for config-shaped route tables.

    Most backends have one tree shape, so their scope table and factories
    bind at module import. A backend whose tree is a function of mount
    config (lancedb's ``group_by`` depth and leaf set, qdrant's likewise)
    builds them per mount instead: the accessor carries the config, so
    the accessor is the cache key, and the cache is weak so a dropped
    mount takes its routes with it. The build runs once per accessor;
    listers, guards and readers stay module-level functions that read
    ``accessor.config`` at call time, so tests keep patching client
    functions the same way they do for import-bound backends.

    Args:
        build (Callable[[A], T]): constructs the per-mount value.
    """
    cache: "WeakKeyDictionary[Accessor, T]" = WeakKeyDictionary()

    def cached(accessor: A) -> T:
        got = cache.get(accessor)
        if got is None:
            got = build(accessor)
            cache[accessor] = got
        return got

    return cached
