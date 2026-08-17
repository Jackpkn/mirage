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
import time


class TokenManager:
    """Caches a short-lived access token, refreshing before expiry.

    Subclasses implement ``refresh_pair`` with their provider's grant.
    The refresh runs under a lock so concurrent callers share one
    round-trip, and ``buffer_seconds`` refreshes early so a token never
    expires mid-request.
    """

    def __init__(self, buffer_seconds: float = 300.0) -> None:
        self._buffer_seconds = buffer_seconds
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()

    async def refresh_pair(self) -> tuple[str, float]:
        """Fetch a fresh token as ``(access_token, expires_in_seconds)``."""
        raise NotImplementedError

    async def get_token(self) -> str:
        async with self._lock:
            if self._access_token and time.time() < self._expires_at:
                return self._access_token
            token, expires_in = await self.refresh_pair()
            self._access_token = token
            self._expires_at = (time.time() + expires_in -
                                self._buffer_seconds)
            return token
