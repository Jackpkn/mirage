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

from mirage.core.hf_hub.repo import fetch_refs, head_commit, repo_info


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.repo.hub_get")
async def test_repo_info_targets_the_typed_api_path(mock_get, accessor):
    mock_get.return_value = {"sha": "abc"}
    assert await repo_info(accessor) == {"sha": "abc"}
    assert mock_get.await_args.args[1].endswith("/api/models/acme/widget")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.repo.hub_get")
async def test_repo_info_of_a_non_object_is_empty(mock_get, accessor):
    mock_get.return_value = []
    assert await repo_info(accessor) == {}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.repo.hub_get")
async def test_fetch_refs_reads_the_refs_endpoint(mock_get, accessor):
    mock_get.return_value = {"branches": [{"name": "main"}], "tags": []}
    refs = await fetch_refs(accessor)
    assert refs["branches"][0]["name"] == "main"
    assert mock_get.await_args.args[1].endswith("/refs")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.repo.hub_get")
async def test_head_commit_reads_the_repo_sha(mock_get, accessor):
    mock_get.return_value = {"sha": "deadbeef"}
    assert await head_commit(accessor) == "deadbeef"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.repo.hub_get")
async def test_head_commit_is_empty_when_the_hub_reports_none(
        mock_get, accessor):
    mock_get.return_value = {}
    assert await head_commit(accessor) == ""
