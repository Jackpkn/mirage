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

import asyncio

import pytest

from mirage.core.api.oauth import TokenManager


class _FakeManager(TokenManager):

    def __init__(self, expires_in: float, buffer_seconds: float) -> None:
        super().__init__(buffer_seconds)
        self.expires_in = expires_in
        self.calls = 0

    async def refresh_pair(self) -> tuple[str, float]:
        self.calls += 1
        return f"tok{self.calls}", self.expires_in


@pytest.mark.asyncio
async def test_caches_until_expiry():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    assert await tm.get_token() == "tok1"
    assert await tm.get_token() == "tok1"
    assert tm.calls == 1


@pytest.mark.asyncio
async def test_the_buffer_refreshes_early():
    # 200s of lifetime minus a 300s buffer is already expired, so every
    # call refreshes.
    tm = _FakeManager(expires_in=200, buffer_seconds=300)
    assert await tm.get_token() == "tok1"
    assert await tm.get_token() == "tok2"
    assert tm.calls == 2


@pytest.mark.asyncio
async def test_concurrent_callers_share_one_refresh():
    tm = _FakeManager(expires_in=3600, buffer_seconds=300)
    tokens = await asyncio.gather(tm.get_token(), tm.get_token(),
                                  tm.get_token())
    assert tokens == ["tok1", "tok1", "tok1"]
    assert tm.calls == 1


@pytest.mark.asyncio
async def test_the_base_class_demands_a_refresh():
    with pytest.raises(NotImplementedError):
        await TokenManager().get_token()
