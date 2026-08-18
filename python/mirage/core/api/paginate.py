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

from mirage.types import PageFetch


async def cursor_items(fetch_page: PageFetch,
                       max_results: int | None = None) -> list[dict[str, Any]]:
    """Collect every item from a cursor-paginated endpoint.

    The reply protocol is the ``results`` / ``has_more`` / ``next_cursor``
    shape (Notion's). Where the resume cursor goes on the request — a
    ``start_cursor`` body field, a query parameter — is the caller's, so
    ``fetch_page`` owns that merge. Pagination stops when the reply stops
    claiming more, or claims more without a usable cursor.

    Args:
        fetch_page (PageFetch): performs one page request; receives the
            cursor to resume from, or None for the first page.
        max_results (int | None): stop after this many items; the tail of
            the last page is sliced off.
    """
    collected: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        data = await fetch_page(cursor)
        page = data.get("results")
        if isinstance(page, list):
            collected.extend(page)
        if max_results is not None and len(collected) >= max_results:
            return collected[:max_results]
        next_cursor = data.get("next_cursor")
        if (not data.get("has_more") or not isinstance(next_cursor, str)
                or not next_cursor):
            return collected
        cursor = next_cursor
