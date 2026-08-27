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

from unittest.mock import patch

import pytest

from mirage.core.hf_hub.rm import rm_r
from tests.core.hf_hub.conftest import ps


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.rm.commit")
async def test_rm_r_deletes_a_directory_as_a_folder(mock_commit, loaded):
    """One commit, not one per file: a per-file loop that failed partway
    would leave the repository half-emptied."""
    await rm_r(loaded, ps("d"))
    assert mock_commit.await_args.kwargs["folders"] == ["d"]
    assert mock_commit.await_count == 1


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.rm.commit")
async def test_rm_r_deletes_a_file_as_a_file(mock_commit, loaded):
    await rm_r(loaded, ps("a.txt"))
    assert mock_commit.await_args.kwargs["deletions"] == ["a.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.rm.commit")
async def test_rm_r_of_a_missing_path_is_enoent(mock_commit, loaded):
    with pytest.raises(FileNotFoundError):
        await rm_r(loaded, ps("nope"))
    mock_commit.assert_not_awaited()
