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

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.readdir import make_readdir
from tests.core.hierarchy.conftest import (detect_scope, list_notes,
                                           list_rooms, room_guard, spec)

READDIR = make_readdir(
    detect_scope,
    listers={
        "rooms": list_rooms,
        "room": list_notes,
    },
    static_root=("rooms", ),
    guards={"room": room_guard},
)


def test_static_root_lists_without_any_call(accessor):
    assert asyncio.run(READDIR(accessor, spec("/"))) == ["/h/rooms"]
    assert accessor.calls == []


def test_dynamic_level_joins_names_under_the_virtual_key(accessor):
    out = asyncio.run(READDIR(accessor, spec("/rooms")))
    assert out == ["/h/rooms/red", "/h/rooms/blue"]


def test_guard_runs_before_the_index_probe(accessor):
    index = RAMIndexCacheStore()
    asyncio.run(READDIR(accessor, spec("/rooms/red"), index=index))
    asyncio.run(READDIR(accessor, spec("/rooms/red"), index=index))
    # Two guard calls, one lister call: the second hit was served from
    # the index but still had to prove the room exists.
    assert accessor.calls == ["guard:red", "notes:red", "guard:red"]


def test_guard_failure_is_enoent_even_for_a_listable_shape(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(READDIR(accessor, spec("/rooms/ghost")))


def test_leaf_and_invalid_paths_refuse(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(READDIR(accessor, spec("/rooms/red/a.json")))
    with pytest.raises(FileNotFoundError):
        asyncio.run(READDIR(accessor, spec("/halls")))


def test_leaf_error_can_be_enotdir(accessor):
    readdir = make_readdir(detect_scope,
                           listers={"rooms": list_rooms},
                           static_root=("rooms", ),
                           leaf_error="enotdir")
    with pytest.raises(NotADirectoryError):
        asyncio.run(readdir(accessor, spec("/rooms/red/a.json")))
