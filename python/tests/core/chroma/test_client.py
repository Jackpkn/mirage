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

from mirage.core.chroma.client import (PAGE_CHUNK_BATCH_SIZE,
                                       fetch_page_chunks, fetch_path_tree,
                                       page_chunks, query_contains)


@pytest.mark.asyncio
async def test_fetch_path_tree(chroma_accessor):
    raw = await fetch_path_tree(chroma_accessor)
    assert "guides/quickstart" in raw


@pytest.mark.asyncio
async def test_fetch_path_tree_missing_raises(chroma_accessor,
                                              chroma_collection):
    del chroma_collection.documents["__path_tree__"]
    chroma_collection.get = _empty_get
    with pytest.raises(FileNotFoundError):
        await fetch_path_tree(chroma_accessor)


async def _empty_get(**kwargs):
    return {"documents": []}


@pytest.mark.asyncio
async def test_page_chunks_sorted_by_chunk_index(chroma_accessor):
    chunks = await page_chunks(chroma_accessor, "guides/quickstart")
    assert [c["document"] for c in chunks] == ["first", "second"]


@pytest.mark.asyncio
async def test_fetch_page_chunks_joins_with_newline(chroma_accessor):
    text = await fetch_page_chunks(chroma_accessor, "guides/quickstart")
    assert text == "first\nsecond"


@pytest.mark.asyncio
async def test_page_chunks_paginates(chroma_accessor, chroma_collection):
    chroma_collection.chunks["big/page"] = [{
        "document": f"chunk-{i}",
        "metadata": {
            "page_slug": "big/page",
            "chunk_index": i
        },
    } for i in range(PAGE_CHUNK_BATCH_SIZE + 5)]
    chunks = await page_chunks(chroma_accessor, "big/page")
    assert len(chunks) == PAGE_CHUNK_BATCH_SIZE + 5
    assert chunks[0]["document"] == "chunk-0"
    assert chunks[-1]["document"] == f"chunk-{PAGE_CHUNK_BATCH_SIZE + 4}"


@pytest.mark.asyncio
async def test_query_contains_scopes_to_candidates(chroma_accessor):
    matched = await query_contains(chroma_accessor, "first",
                                   ["guides/quickstart", "api/reference"])
    assert matched == ["guides/quickstart"]


@pytest.mark.asyncio
async def test_query_contains_empty_candidates_short_circuits(
        chroma_accessor, chroma_collection):
    matched = await query_contains(chroma_accessor, "first", [])
    assert matched == []
    assert not chroma_collection.contains_queries
