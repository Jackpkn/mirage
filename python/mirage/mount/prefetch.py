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

import time

# How long prefetched bytes for size-unknown files outlive their handle,
# so a release-then-stat burst (ls right after cat) neither refetches nor
# reports an unknown size. Mirrors the TS PREFETCH_TTL_MS.
PREFETCH_TTL = 30.0


class PrefetchCache:
    """Bytes of size-unknown files, held briefly past their handle.

    A backend that cannot answer a size until the content is fetched
    would otherwise refetch on every stat that follows a read, which over
    a mount is one API call per `ls -l` entry. Holding the bytes for a
    short window makes the release-then-stat burst free without pinning
    memory for the life of the mount.

    Sync on purpose: expiry is a clock read and eviction is a dict
    delete, so nothing here awaits. Only the fill is async, and it lives
    in the core, which is the layer that knows how to reach a backend.

    Args:
        ttl (float): seconds an entry stays fresh after it is stored.
    """

    __slots__ = ("_entries", "_ttl")

    def __init__(self, ttl: float = PREFETCH_TTL) -> None:
        self._entries: dict[str, tuple[bytes, float]] = {}
        self._ttl = ttl

    def get(self, path: str) -> bytes | None:
        """The cached bytes for a path, when they are still fresh.

        A stale entry is dropped rather than returned, so a caller never
        has to check the clock itself.

        Args:
            path (str): mount path to look up.

        Returns:
            bytes | None: the content, or None when nothing fresh is held.
        """
        entry = self._entries.get(path)
        if entry is None:
            return None
        data, expires = entry
        if time.monotonic() >= expires:
            del self._entries[path]
            return None
        return data

    def put(self, path: str, data: bytes) -> None:
        """Hold a path's bytes for the cache's TTL.

        Args:
            path (str): mount path the bytes belong to.
            data (bytes): the content that was fetched.
        """
        self._entries[path] = (data, time.monotonic() + self._ttl)

    def invalidate(self, *paths: str) -> None:
        """Drop the entries for paths whose content may have changed.

        Every mutation the core performs calls this: serving a stale
        read after a write is worse than the refetch it saves.

        Args:
            *paths (str): mount paths to forget. Unknown ones are fine.
        """
        for path in paths:
            self._entries.pop(path, None)

    def clear(self) -> None:
        """Forget everything held."""
        self._entries.clear()
