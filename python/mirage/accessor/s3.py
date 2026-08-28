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
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator

from mirage.accessor.base import Accessor
from mirage.utils import key_prefix as kp


class S3Config(BaseModel):
    model_config = ConfigDict(frozen=True)

    bucket: str
    region: str | None = None
    endpoint_url: str | None = None
    aws_access_key_id: SecretStr | None = None
    aws_secret_access_key: SecretStr | None = None
    aws_session_token: SecretStr | None = None
    aws_profile: str | None = None
    path_style: bool = False
    timeout: int = 30
    proxy: SecretStr | None = None
    key_prefix: str | None = None

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None


class S3Accessor(Accessor):

    def __init__(self, config: S3Config) -> None:
        self.config = config
        # One live client per event loop, the way GridFSAccessor keeps its
        # motor client, because an aioboto3 client is bound to the loop that
        # opened it. Opening one costs ~50ms (botocore builds the S3 service
        # model and a fresh connection pool), so the old client-per-operation
        # made every op 24x its own cost.
        #
        # The accessor owns the LIFETIME and the driver owns the
        # CONSTRUCTION: building a client needs the kwargs helpers in
        # mirage.core.s3.client, and that module imports S3Config from here,
        # so constructing one here would be a cycle.
        self._stacks: dict[int, AsyncExitStack] = {}
        self._clients: dict[int, Any] = {}
        self._locks: dict[int, asyncio.Lock] = {}

    async def cached_client(
            self, factory: Callable[[],
                                    AbstractAsyncContextManager[Any]]) -> Any:
        """Return this loop's live client, opening one when there is none.

        Args:
            factory (Callable): builds the client context manager. Called
                only on a miss, so a hit costs one dict lookup.

        Returns:
            Any: the open aioboto3 client for the running loop.
        """
        key = id(asyncio.get_running_loop())
        live = self._clients.get(key)
        if live is not None:
            return live
        # Opening is serialized per loop. `factory()` may suspend (resolving
        # credentials can reach IMDS or SSO), and two callers that both miss
        # would then each open a client and each store it under this one key,
        # so the loser's AsyncExitStack becomes unreachable and `close` can
        # never close its connection pool. setdefault is atomic here because
        # nothing awaits between the read and the write, so both callers take
        # the same lock. TypeScript's SSH accessor guards the same way with a
        # cached connectPromise.
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            live = self._clients.get(key)
            if live is not None:
                return live
            stack = AsyncExitStack()
            client = await stack.enter_async_context(factory())
            self._stacks[key] = stack
            self._clients[key] = client
            return client

    async def close(self) -> None:
        """Close every client this accessor opened."""
        stacks = list(self._stacks.values())
        self._stacks.clear()
        self._clients.clear()
        self._locks.clear()
        for stack in stacks:
            await stack.aclose()
