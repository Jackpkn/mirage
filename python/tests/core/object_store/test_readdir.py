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
from mirage.core.object_store.readdir import make_readdir
from tests.core.object_store.conftest import FakeStore, make_driver, spec


def test_readdir_lists_files_and_collapsed_dirs(accessor):
    store = FakeStore({"a.txt": b"hi", "dir/f.txt": b"x", "dir/sub/g": b"y"})
    readdir = make_readdir(make_driver(store))
    out = asyncio.run(readdir(accessor, spec("/")))
    assert out == ["/mnt/a.txt", "/mnt/dir"]


def test_readdir_marker_only_directory_is_empty_not_missing(accessor):
    store = FakeStore({"empty/": b""})
    readdir = make_readdir(make_driver(store))
    assert asyncio.run(readdir(accessor, spec("/empty"))) == []


def test_readdir_missing_path_is_enoent(accessor):
    store = FakeStore({"a.txt": b"hi"})
    readdir = make_readdir(make_driver(store))
    with pytest.raises(FileNotFoundError):
        asyncio.run(readdir(accessor, spec("/never")))


def test_readdir_on_a_file_is_enotdir(accessor):
    store = FakeStore({"a.txt": b"hi"})
    readdir = make_readdir(make_driver(store))
    with pytest.raises(NotADirectoryError):
        asyncio.run(readdir(accessor, spec("/a.txt")))


def test_readdir_root_of_an_empty_store_does_not_raise(accessor):
    readdir = make_readdir(make_driver(FakeStore()))
    assert asyncio.run(readdir(accessor, spec("/"))) == []


def test_readdir_populates_index(accessor):
    store = FakeStore({"a.txt": b"hi", "dir/f.txt": b"x"})
    readdir = make_readdir(make_driver(store))
    index = RAMIndexCacheStore()
    asyncio.run(readdir(accessor, spec("/"), index=index))
    lookup = asyncio.run(index.get("/mnt/a.txt"))
    assert lookup.entry is not None
    assert lookup.entry.size == 2
    folder = asyncio.run(index.get("/mnt/dir"))
    assert folder.entry is not None
    assert folder.entry.size is None


def test_readdir_serves_a_cached_listing_without_connecting(accessor):
    store = FakeStore({"a.txt": b"hi"})
    readdir = make_readdir(make_driver(store))
    index = RAMIndexCacheStore()
    first = asyncio.run(readdir(accessor, spec("/"), index=index))
    connects = store.connects
    second = asyncio.run(readdir(accessor, spec("/"), index=index))
    assert first == second
    assert store.connects == connects
