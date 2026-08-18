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

from typing import Any

import pytest

from mirage.core.api.paginate import cursor_items


class _Pager:

    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = list(pages)
        self.cursors: list[str | None] = []

    async def fetch(self, cursor: str | None) -> dict[str, Any]:
        self.cursors.append(cursor)
        return self.pages.pop(0)


@pytest.mark.asyncio
async def test_collects_across_pages_and_threads_the_cursor():
    pager = _Pager([
        {
            "results": [{
                "n": 1
            }, {
                "n": 2
            }],
            "has_more": True,
            "next_cursor": "c1",
        },
        {
            "results": [{
                "n": 3
            }],
            "has_more": False,
        },
    ])
    items = await cursor_items(pager.fetch)
    assert [item["n"] for item in items] == [1, 2, 3]
    assert pager.cursors == [None, "c1"]


@pytest.mark.asyncio
async def test_max_results_slices_the_last_page():
    pager = _Pager([
        {
            "results": [{
                "n": 1
            }, {
                "n": 2
            }],
            "has_more": True,
            "next_cursor": "c1",
        },
        {
            "results": [{
                "n": 3
            }, {
                "n": 4
            }],
            "has_more": True,
            "next_cursor": "c2",
        },
    ])
    items = await cursor_items(pager.fetch, max_results=3)
    assert [item["n"] for item in items] == [1, 2, 3]
    assert len(pager.cursors) == 2


@pytest.mark.asyncio
async def test_has_more_without_a_usable_cursor_stops():
    pager = _Pager([{"results": [{"n": 1}], "has_more": True}])
    assert await cursor_items(pager.fetch) == [{"n": 1}]

    pager = _Pager([{
        "results": [{
            "n": 1
        }],
        "has_more": True,
        "next_cursor": "",
    }])
    assert await cursor_items(pager.fetch) == [{"n": 1}]


@pytest.mark.asyncio
async def test_a_non_list_results_field_contributes_nothing():
    pager = _Pager([{"results": {"weird": 1}, "has_more": False}])
    assert await cursor_items(pager.fetch) == []
