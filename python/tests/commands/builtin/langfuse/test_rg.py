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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.langfuse.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.resource.langfuse.config import LangfuseConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return LangfuseAccessor(LangfuseConfig(public_key="pk", secret_key="sk"))


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


def _opts(**flags) -> CommandOpts:
    return CommandOpts(index=RAMIndexCacheStore(), flags={**flags})


SUMMARIES = [
    {
        "id": "t1",
        "name": "alpha search-me"
    },
    {
        "id": "t2",
        "name": "beta"
    },
]


@pytest.mark.asyncio
async def test_fast_path_matches_listing_summaries(accessor):
    with patch("mirage.commands.builtin.langfuse.rg.fetch_traces",
               new=AsyncMock(return_value=SUMMARIES)) as fetch:
        stdout, io = await rg(accessor, [_spec("/traces")], ["search-me"],
                              _opts())
    fetch.assert_awaited_once()
    text = (stdout if isinstance(stdout, bytes) else b"").decode()
    assert "traces/t1.json:" in text
    assert "t2" not in text
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_shaping_flag_defers_to_generic(accessor):
    with patch("mirage.commands.builtin.langfuse.rg.fetch_traces",
               new=AsyncMock(return_value=SUMMARIES)) as fetch, patch(
                   "mirage.commands.builtin.langfuse.rg.resolve_glob",
                   new=AsyncMock(return_value=[])), patch(
                       "mirage.commands.builtin.langfuse.rg.generic_rg",
                       new=AsyncMock(return_value=(b"",
                                                   IOResult()))) as generic:
        await rg(accessor, [_spec("/traces")], ["search-me"],
                 _opts(args_l=True))
    fetch.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_unresolved_glob_defers_to_generic(accessor):
    with patch("mirage.commands.builtin.langfuse.rg.fetch_traces",
               new=AsyncMock(return_value=SUMMARIES)) as fetch, patch(
                   "mirage.commands.builtin.langfuse.rg.resolve_glob",
                   new=AsyncMock(return_value=[])), patch(
                       "mirage.commands.builtin.langfuse.rg.generic_rg",
                       new=AsyncMock(return_value=(b"",
                                                   IOResult()))) as generic:
        await rg(accessor, [_spec("/traces/*")], ["search-me"], _opts())
    fetch.assert_not_awaited()
    generic.assert_awaited_once()
