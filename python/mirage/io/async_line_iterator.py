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

from collections.abc import AsyncIterator


class AsyncLineIterator:

    def __init__(self, source: AsyncIterator[bytes]) -> None:
        self._source = source
        self._buf = b""
        self._exhausted = False

    def __aiter__(self) -> "AsyncLineIterator":
        return self

    async def __anext__(self) -> bytes:
        line = await self.readline()
        if line is None:
            raise StopAsyncIteration
        return line

    async def readline(self) -> bytes | None:
        """Return next line (without trailing newline), or None at EOF."""
        while b"\n" not in self._buf:
            if self._exhausted:
                if self._buf:
                    remaining = self._buf
                    self._buf = b""
                    return remaining
                return None
            try:
                chunk = await self._source.__anext__()
            except StopAsyncIteration:
                self._exhausted = True
                continue
            self._buf += chunk
        line, self._buf = self._buf.split(b"\n", 1)
        return line

    async def read_until(self, delim: bytes) -> tuple[bytes, bool]:
        """Read up to (not including) ``delim``, or to EOF.

        Args:
            delim (bytes): the one-byte delimiter; ``b"\0"`` for NUL.

        Returns:
            tuple[bytes, bool]: the bytes read and whether the delimiter
            was found (False means EOF ended the read, which is what
            ``read`` reports as status 1).
        """
        while delim not in self._buf:
            if self._exhausted:
                remaining = self._buf
                self._buf = b""
                return remaining, False
            try:
                chunk = await self._source.__anext__()
            except StopAsyncIteration:
                self._exhausted = True
                continue
            self._buf += chunk
        data, self._buf = self._buf.split(delim, 1)
        return data, True

    async def read_chars(self, count: int,
                         delim: bytes | None) -> tuple[bytes, bool]:
        """Read at most ``count`` bytes, stopping early at ``delim``.

        ``read -n`` is "up to N characters or the delimiter, whichever
        first" and ``read -N`` is "exactly N, delimiters included", which
        is this with ``delim`` None. The delimiter is consumed and not
        returned.

        Args:
            count (int): the byte budget.
            delim (bytes | None): the one-byte stop, or None to read
                through delimiters.

        Returns:
            tuple[bytes, bool]: the bytes read and whether the read
            ended on its own terms (the count reached, or the delimiter
            seen) rather than at EOF.
        """
        out = bytearray()
        while len(out) < count:
            if not self._buf:
                if self._exhausted:
                    return bytes(out), False
                try:
                    self._buf = await self._source.__anext__()
                except StopAsyncIteration:
                    self._exhausted = True
                continue
            take = self._buf[:count - len(out)]
            if delim is not None and delim in take:
                head, _ = take.split(delim, 1)
                out += head
                self._buf = self._buf[len(head) + 1:]
                return bytes(out), True
            out += take
            self._buf = self._buf[len(take):]
        return bytes(out), True
