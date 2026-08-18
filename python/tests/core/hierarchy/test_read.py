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
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import RouteMatch
from mirage.types import PathSpec
from tests.core.hierarchy.conftest import FakeAccessor, detect_scope, spec


async def _read_note(accessor: FakeAccessor, match: RouteMatch, path: PathSpec,
                     index: IndexCacheStore) -> bytes:
    return f"{match.captures['room']}:{match.captures['note']}".encode()


READ = make_read(detect_scope, {"note": _read_note})


def test_reader_gets_the_captures(accessor):
    out = asyncio.run(READ(accessor, spec("/rooms/red/a.json")))
    assert out == b"red:a"


def test_everything_else_is_enoent(accessor):
    for path in ("/", "/rooms", "/rooms/red", "/rooms/.red/a.json", "/halls"):
        with pytest.raises(FileNotFoundError):
            asyncio.run(READ(accessor, spec(path)))
