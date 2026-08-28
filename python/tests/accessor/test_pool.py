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

from mirage.accessor.pool import LoopClientCache


class Stub:
    """A client that records its own open and release.

    A class, not an @asynccontextmanager generator: a generator's `finally`
    runs when the generator is collected, which reports a released client even
    when the cache abandoned it, and hides exactly the bug these tests exist
    to catch.

    Args:
        opened (list): receives this client's id when it opens.
        released (list): receives this client's id when it is released.
        counter (list): single-item id source, so ids are stable.
        fail_release (bool): raise from __aexit__ once, to model a shutdown
            that is cancelled or errors.
        slow_open (bool): suspend inside __aenter__, opening the window two
            concurrent callers race in.
    """

    def __init__(self, opened, released, counter, fail_release=False,
                 slow_open=False) -> None:
        self.opened = opened
        self.released = released
        self.counter = counter
        self.fail_release = fail_release
        self.slow_open = slow_open
        self.ident = -1

    async def __aenter__(self) -> str:
        if self.slow_open:
            await asyncio.sleep(0.01)
        self.ident = self.counter[0]
        self.counter[0] += 1
        self.opened.append(self.ident)
        return f"client-{self.ident}"

    async def __aexit__(self, *exc) -> bool:
        if self.fail_release:
            self.fail_release = False
            raise RuntimeError("release failed")
        self.released.append(self.ident)
        return False


def _stub(opened, released, counter, **kw):
    return lambda: Stub(opened, released, counter, **kw)


def test_hit_reuses_one_client():
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")

    async def go():
        first = await cache.get(_stub(opened, released, counter))
        second = await cache.get(_stub(opened, released, counter))
        assert first == second
        await cache.close()

    asyncio.run(go())
    assert opened == [0]
    assert released == [0]


def test_concurrent_miss_opens_exactly_one():
    """Two callers that both miss must not each open a client.

    The loser's stack would be unreachable, so its connection pool could never
    be closed.
    """
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")

    async def go():
        got = await asyncio.gather(
            *[cache.get(_stub(opened, released, counter, slow_open=True))
              for _ in range(5)])
        assert len(set(got)) == 1
        await cache.close()

    asyncio.run(go())
    assert opened == [0]
    assert released == [0]


def test_client_from_a_closed_loop_is_released_not_forgotten():
    """A closing loop does not run the client's context manager.

    Dropping the entry would abandon the connection pool, so the cache has to
    release it from the later loop.
    """
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")

    async def step():
        await cache.get(_stub(opened, released, counter))

    for _ in range(3):
        asyncio.run(step())
    asyncio.run(cache.close())

    assert opened == [0, 1, 2]
    assert released == [0, 1, 2]
    assert cache.open_count() == 0


def test_a_failed_release_keeps_the_entry_retryable():
    """A release that raises must not lose the client.

    Clearing the map first meant a cancelled or failing shutdown dropped an
    entry whose client was still open, and nothing could retry it.
    """
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")

    async def go():
        await cache.get(_stub(opened, released, counter, fail_release=True))
        await cache.close()
        assert cache.open_count() == 1, "a failed release must keep the entry"
        assert released == []
        # The manager is held rather than wrapped in an AsyncExitStack, so the
        # retry really re-invokes __aexit__ instead of finding a spent stack.
        await cache.close()
        assert cache.open_count() == 0
        assert released == [0]

    asyncio.run(go())


def test_a_failed_release_does_not_strand_the_other_loops():
    """One client failing to release must not cost the others theirs.

    The entry that failed stays, and because `release_dead` runs on every
    `get`, the next operation retries it: all three end up released rather
    than one failure stranding the rest.
    """
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")
    fail_first = [True]

    async def step():
        await cache.get(
            _stub(opened, released, counter, fail_release=fail_first[0]))
        fail_first[0] = False

    for _ in range(3):
        asyncio.run(step())
    asyncio.run(cache.close())

    assert opened == [0, 1, 2]
    assert sorted(released) == [0, 1, 2], "a failed release stranded a client"
    assert cache.open_count() == 0


def test_key_is_the_loop_object_not_its_id():
    """Two runs must not share a client because ids collide.

    CPython reuses the address of a collected loop, so keying on `id(loop)`
    could hand the second run a client bound to the first run's closed loop.
    """
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")
    seen = []

    async def step():
        seen.append(await cache.get(_stub(opened, released, counter)))

    asyncio.run(step())
    asyncio.run(step())
    assert seen[0] != seen[1], "each run needs its own client"
    asyncio.run(cache.close())
    assert sorted(released) == [0, 1]


@pytest.mark.asyncio
async def test_open_count_reports_live_clients():
    opened, released, counter = [], [], [0]
    cache = LoopClientCache("test")
    assert cache.open_count() == 0
    await cache.get(_stub(opened, released, counter))
    assert cache.open_count() == 1
    await cache.close()
    assert cache.open_count() == 0
