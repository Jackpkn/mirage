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

from mirage.cache.index import IndexCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import RouteMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import FileStat, FileType, PathSpec
from tests.core.hierarchy.conftest import (FakeAccessor, detect_scope,
                                           list_notes, list_rooms,
                                           room_guard, spec)

READDIR = make_readdir(
    detect_scope,
    listers={
        "rooms": list_rooms,
        "room": list_notes,
    },
    static_root=("rooms", ),
    guards={"room": room_guard},
)


def _room_extra(match: RouteMatch) -> dict[str, str]:
    return {"room": match.captures["room"]}


STAT = make_stat(
    detect_scope,
    READDIR,
    guards={"room": room_guard},
    extras={"room": _room_extra},
)


def test_root_and_static_dirs_answer_without_probing(accessor):
    assert asyncio.run(STAT(accessor, spec("/"))).name == "/"
    st = asyncio.run(STAT(accessor, spec("/rooms")))
    assert st.type == FileType.DIRECTORY
    assert st.name == "rooms"
    assert accessor.calls == []


def test_guarded_dir_carries_extras(accessor):
    st = asyncio.run(STAT(accessor, spec("/rooms/red")))
    assert st.type == FileType.DIRECTORY
    assert st.extra == {"room": "red"}
    assert accessor.calls == ["guard:red"]


def test_leaf_proves_existence_through_the_parent_listing(accessor):
    index = RAMIndexCacheStore()
    st = asyncio.run(STAT(accessor, spec("/rooms/red/a.json"), index=index))
    assert st.type == FileType.JSON
    assert st.size == 7
    with pytest.raises(FileNotFoundError):
        asyncio.run(STAT(accessor, spec("/rooms/red/nope.json"),
                         index=index))


def test_invalid_shapes_are_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(STAT(accessor, spec("/halls")))
    with pytest.raises(FileNotFoundError):
        asyncio.run(STAT(accessor, spec("/rooms/.red")))


def test_override_replaces_the_whole_shape(accessor):
    async def bespoke(accessor: FakeAccessor, match: RouteMatch,
                      path: PathSpec, index: IndexCacheStore) -> FileStat:
        return FileStat(name="custom", type=FileType.TEXT, size=1)

    stat = make_stat(detect_scope, READDIR, overrides={"note": bespoke})
    st = asyncio.run(stat(accessor, spec("/rooms/red/a.json")))
    assert st.name == "custom"
    assert accessor.calls == []
