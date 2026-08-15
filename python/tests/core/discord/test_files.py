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

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.core.discord.files import download_file

BODY = b"0123456789"


def _session(status: int, body: bytes) -> MagicMock:
    """An aiohttp session whose one response carries `status` and `body`.

    Args:
        status (int): the response status to report.
        body (bytes): the body to return from ``read``.
    """
    resp = AsyncMock()
    resp.status = status
    resp.read = AsyncMock(return_value=body)
    resp.raise_for_status = MagicMock()
    session = AsyncMock()
    session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=resp),
        __aexit__=AsyncMock(return_value=False),
    ))
    return session


async def _download(status: int, body: bytes, offset: int,
                    size: int | None) -> tuple[bytes, MagicMock]:
    session = _session(status, body)
    with patch("mirage.core.discord.files.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)
        data = await download_file("https://cdn.example/a.csv", offset, size)
    return data, session


@pytest.mark.asyncio
async def test_the_window_is_sent_as_a_range_header():
    _, session = await _download(206, b"234", 2, 3)

    assert session.get.call_args.kwargs["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_206_body_is_trusted_as_the_window():
    data, _ = await _download(206, b"234", 2, 3)

    assert data == b"234"


@pytest.mark.asyncio
async def test_a_200_is_sliced_because_the_cdn_ignored_the_range():
    """A CDN may legally answer 200 with the whole file to a Range
    request. Before this was handled the caller got every byte for what
    it asked to be a window."""
    data, _ = await _download(200, BODY, 2, 3)

    assert data == b"234"


@pytest.mark.asyncio
async def test_no_window_sends_no_header_and_reads_whole():
    data, session = await _download(200, BODY, 0, None)

    assert data == BODY
    assert session.get.call_args.kwargs["headers"] is None
