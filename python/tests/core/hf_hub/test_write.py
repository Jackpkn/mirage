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

from mirage.core.hf_hub.write import drop_tree, write_bytes
from tests.core.hf_hub.conftest import ps


def test_drop_tree_forgets_the_listing_and_its_derived_rows(loaded):
    """The accessor's tree IS the listing, so a write that leaves it in
    place makes find and du answer from the pre-commit repository."""
    loaded.rows_cache = ("", {}, {})
    drop_tree(loaded)
    assert loaded.tree == {}
    assert loaded.tree_loaded is False
    assert loaded.rows_cache is None


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.write.commit")
async def test_write_bytes_commits_one_addition(mock_commit, loaded):
    await write_bytes(loaded, ps("a.txt"), b"hi")
    addition = mock_commit.await_args.kwargs["additions"][0]
    assert addition.path == "a.txt"
    assert addition.data == b"hi"
    assert loaded.tree_loaded is False


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.write.commit")
async def test_write_bytes_prefixes_the_repo_path(mock_commit, prefixed):
    await write_bytes(prefixed, ps("a.txt"), b"hi")
    assert mock_commit.await_args.kwargs["additions"][
        0].path == "sub/dir/a.txt"
