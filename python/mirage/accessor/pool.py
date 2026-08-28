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
import logging
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _Entry:
    """One open client and the context manager that releases it.

    The context manager itself, not an AsyncExitStack wrapping it: a stack
    pops each callback BEFORE invoking it, so once an exit raises or is
    cancelled that callback is gone and a later attempt silently does
    nothing. Holding the manager means `__aexit__` can actually be called
    again, which is what makes a failed release retryable rather than merely
    remembered.

    Args:
        client (Any): the open client.
        manager (AbstractAsyncContextManager): releases the client on exit.
    """
    client: Any
    manager: AbstractAsyncContextManager[Any]


class LoopClientCache:
    """One open client per event loop, opened once and released exactly once.

    A client that costs real time to build is worth keeping, but keeping it
    turns its lifetime into this object's problem: whatever used to close at
    the end of every operation no longer does. The whole point of this class
    is that "opened" and "released" cannot drift apart, so the three ways they
    did are structural here rather than left to each call site:

    - opening is serialized per loop, so two callers that both miss cannot
      each open a client and have one of them go untracked;
    - an entry is dropped only after its release has COMPLETED, so an exit
      that raises or is cancelled leaves the entry retryable rather than
      unreachable;
    - a loop that closed still has its client released, from a later loop,
      rather than forgotten.

    Clients bind to the loop that opened them, so the key is the loop OBJECT.
    Never `id(loop)`: CPython reuses the address of a collected loop, so a
    second `asyncio.run()` can hash to a client belonging to the first run's
    closed loop.
    """

    def __init__(self, what: str) -> None:
        """Build an empty cache.

        Args:
            what (str): what is being cached, for log lines ("s3").
        """
        self.what = what
        self._entries: dict[asyncio.AbstractEventLoop, _Entry] = {}
        self._locks: dict[asyncio.AbstractEventLoop, asyncio.Lock] = {}

    async def get(
        self, factory: Callable[[], AbstractAsyncContextManager[Any]]
    ) -> Any:
        """Return this loop's client, opening one when there is none.

        Args:
            factory (Callable): builds the client context manager. Called
                only on a miss, so a hit costs one dict lookup.

        Returns:
            Any: the open client for the running loop.
        """
        loop = asyncio.get_running_loop()
        await self.release_dead()
        entry = self._entries.get(loop)
        if entry is not None:
            return entry.client
        # `factory()` may suspend (resolving credentials can reach IMDS or
        # SSO), so without this two callers that both miss would each open a
        # client and the loser's manager would never be reachable again.
        # setdefault is atomic because nothing awaits between the read and the
        # write, so both callers take the same lock.
        lock = self._locks.setdefault(loop, asyncio.Lock())
        async with lock:
            entry = self._entries.get(loop)
            if entry is not None:
                return entry.client
            manager = factory()
            client = await manager.__aenter__()
            self._entries[loop] = _Entry(client=client, manager=manager)
            return client

    async def _release(self, loop: asyncio.AbstractEventLoop) -> None:
        """Release one entry, forgetting it only once its exit has finished.

        Args:
            loop (asyncio.AbstractEventLoop): the loop whose client to close.
        """
        entry = self._entries.get(loop)
        if entry is None:
            return
        # The pops come AFTER the await on purpose. Clearing first meant a
        # cancelled or failing shutdown dropped the entry while its client was
        # still open, and nothing could retry it.
        await entry.manager.__aexit__(None, None, None)
        self._entries.pop(loop, None)
        self._locks.pop(loop, None)

    async def release_dead(self) -> None:
        """Close the clients whose loop has gone.

        A closing loop does not run the client's context manager, so an entry
        left behind is an abandoned connection pool. Exiting the manager from
        a later loop does work, so close it rather than forgetting it.
        """
        for loop in [one for one in self._entries if one.is_closed()]:
            await self._release_logging(loop)

    async def _release_logging(self, loop: asyncio.AbstractEventLoop) -> None:
        """Release one entry, reporting a failure instead of raising it.

        Args:
            loop (asyncio.AbstractEventLoop): the loop whose client to close.
        """
        try:
            await self._release(loop)
        except Exception as exc:
            # Not fatal to the caller, and not silent either. The entry stays
            # in the map, so the next `release_dead` or `close` retries it.
            logger.debug("%s: releasing a client failed, will retry: %s",
                         self.what, exc)

    async def close(self) -> None:
        """Close every client this cache opened.

        One failure must not skip the rest, and must not lose the entry that
        failed: every loop is attempted and anything still open stays in the
        map for a later attempt.
        """
        for loop in list(self._entries):
            await self._release_logging(loop)

    def open_count(self) -> int:
        """Return how many clients are currently held.

        Returns:
            int: number of open clients.
        """
        return len(self._entries)
