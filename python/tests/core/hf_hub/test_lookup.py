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

import pytest

from mirage.cache.index import NULL_INDEX
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hf_hub.lookup import (dir_stat_entry, key_of, lookup,
                                       probe_dir, probe_file)
from mirage.core.hf_hub.tree import seed_index


@pytest.mark.parametrize("prefix,local,expected", [
    ("", "a.txt", "/a.txt"),
    ("", "", "/"),
    ("/m", "a.txt", "/m/a.txt"),
    ("/m", "", "/m"),
    ("/m", "/d/a.txt", "/m/d/a.txt"),
])
def test_key_of_builds_a_mount_absolute_key(prefix, local, expected):
    assert key_of(prefix, local) == expected


@pytest.mark.asyncio
async def test_lookup_answers_from_the_tree_without_an_index(loaded):
    found = await lookup(loaded, NULL_INDEX, "", "/a.txt")
    assert found.exists and not found.is_dir
    assert found.entry.size == 7


@pytest.mark.asyncio
async def test_lookup_and_the_index_agree(loaded):
    """Both paths are built by index_rows, so they cannot disagree."""
    index = RAMIndexCacheStore()
    seed_index(loaded, index, "")
    without = await lookup(loaded, NULL_INDEX, "", "/d")
    with_index = await lookup(loaded, index, "", "/d")
    assert without.is_dir and with_index.is_dir
    assert without.children == with_index.children == ["/d/b.txt"]


@pytest.mark.asyncio
async def test_lookup_reports_a_directory_with_no_row_of_its_own(accessor):
    from tests.core.hf_hub.conftest import file_row, seed
    seed(accessor, file_row("d/b.txt"))
    found = await lookup(accessor, NULL_INDEX, "", "/d")
    assert found.is_dir is True
    assert found.entry is None
    assert found.exists is True


@pytest.mark.asyncio
async def test_lookup_reports_an_absence(loaded):
    found = await lookup(loaded, NULL_INDEX, "", "/nope")
    assert found.exists is False
    assert found.is_dir is False


@pytest.mark.asyncio
async def test_probes_tell_a_file_from_a_directory(loaded):
    assert await probe_file(loaded, NULL_INDEX, "", "a.txt") is True
    assert await probe_dir(loaded, NULL_INDEX, "", "a.txt") is False
    assert await probe_dir(loaded, NULL_INDEX, "", "d") is True
    assert await probe_file(loaded, NULL_INDEX, "", "d") is False
    assert await probe_file(loaded, NULL_INDEX, "", "nope") is False


def test_dir_stat_entry_names_the_last_segment():
    entry = dir_stat_entry("/m/deep/dir")
    assert entry.name == "dir"
    assert entry.resource_type == "folder"
