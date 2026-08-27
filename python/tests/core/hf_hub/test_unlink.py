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

from mirage.core.hf_hub.unlink import unlink
from tests.core.hf_hub.conftest import ps


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.unlink.commit")
async def test_unlink_commits_a_file_deletion(mock_commit, loaded):
    await unlink(loaded, ps("a.txt"))
    assert mock_commit.await_args.kwargs["deletions"] == ["a.txt"]
    assert loaded.tree_loaded is False


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.unlink.commit")
async def test_unlink_of_a_missing_path_is_enoent(mock_commit, loaded):
    with pytest.raises(FileNotFoundError):
        await unlink(loaded, ps("nope"))
    mock_commit.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.unlink.commit")
async def test_unlink_of_a_directory_is_eisdir(mock_commit, loaded):
    """A directory operand must not silently delete a subtree the caller
    never named recursively."""
    with pytest.raises(IsADirectoryError):
        await unlink(loaded, ps("d"))
    mock_commit.assert_not_awaited()
