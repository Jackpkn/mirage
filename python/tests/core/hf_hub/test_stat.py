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

from mirage.cache.index import IndexEntry
from mirage.core.hf_hub.stat import stat, stat_of
from mirage.types import FileType
from tests.core.hf_hub.conftest import file_row, ps, seed


@pytest.mark.asyncio
async def test_stat_of_the_mount_root_is_a_directory(loaded):
    result = await stat(loaded, ps(""))
    assert result.type is FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_reports_size_and_the_oid_as_fingerprint(loaded):
    result = await stat(loaded, ps("a.txt"))
    assert result.size == 7
    assert result.type is FileType.FILE
    assert result.fingerprint == "oid-a.txt"


@pytest.mark.asyncio
async def test_stat_of_a_directory_with_no_row_of_its_own(accessor):
    seed(accessor, file_row("d/b.txt"))
    result = await stat(accessor, ps("d"))
    assert result.type is FileType.DIRECTORY
    assert result.name == "d"


@pytest.mark.asyncio
async def test_stat_of_a_missing_path_is_enoent(loaded):
    with pytest.raises(FileNotFoundError):
        await stat(loaded, ps("nope"))


@pytest.mark.asyncio
async def test_stat_reports_the_lfs_object_size(accessor):
    """The 135-byte pointer is what git stores; the content size is what
    every reader needs, and reporting the pointer risks a short copy."""
    seed(
        accessor,
        file_row("w.bin",
                 4798702184,
                 lfs={
                     "oid": "sha",
                     "size": 4798702184,
                     "pointerSize": 135
                 }))
    result = await stat(accessor, ps("w.bin"))
    assert result.size == 4798702184
    assert result.extra["lfs_oid"] == "sha"


def test_stat_of_leaves_mtime_unset_when_the_row_has_none():
    """A Hub file's only mtime is its last commit, and a bare listing
    carries none. None is the honest answer; a repo-wide timestamp
    stamped on every file would be a confident lie."""
    assert stat_of(IndexEntry(id="o", name="f",
                              resource_type="file")).modified is None


def test_stat_of_reports_an_expanded_mtime():
    entry = IndexEntry(id="o",
                       name="f",
                       resource_type="file",
                       remote_time="2025-01-01T00:00:00.000Z")
    assert stat_of(entry).modified == "2025-01-01T00:00:00.000Z"
