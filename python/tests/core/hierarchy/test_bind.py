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

import gc
import weakref

from mirage.core.hierarchy.bind import per_accessor

from .conftest import FakeAccessor


def test_builds_once_per_accessor():
    built: list[FakeAccessor] = []

    def build(accessor: FakeAccessor) -> list[str]:
        built.append(accessor)
        return [f"routes-{len(built)}"]

    cached = per_accessor(build)
    accessor = FakeAccessor()
    first = cached(accessor)
    assert cached(accessor) is first
    assert built == [accessor]


def test_distinct_accessors_get_distinct_builds():
    cached = per_accessor(lambda accessor: object())
    one = FakeAccessor()
    two = FakeAccessor()
    assert cached(one) is not cached(two)


def test_cache_is_weak():
    cached = per_accessor(lambda accessor: object())
    accessor = FakeAccessor()
    cached(accessor)
    ref = weakref.ref(accessor)
    del accessor
    gc.collect()
    assert ref() is None
