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


def char_width(data: bytes) -> int:
    """How many bytes ``data``'s first character spans, decoded as UTF-8.

    Always at least one and never more than what is there, so a caller
    stepping by this never splits a character and never stalls. Bytes
    that decode to one replacement character answer 1, which is what
    ``decode(errors="replace")`` makes of them: a stray continuation
    byte, a lead the encoding never uses, and a sequence cut short by a
    byte that cannot continue it.

    Args:
        data (bytes): the buffer, at least one byte.
    """
    lead = data[0]
    if lead < 0xC2 or lead >= 0xF5:
        return 1
    width = 2 if lead < 0xE0 else 3 if lead < 0xF0 else 4
    for i in range(1, min(width, len(data))):
        if not 0x80 <= data[i] < 0xC0:
            return i
    return min(width, len(data))


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
        """Read at most ``count`` characters, stopping early at ``delim``.

        ``read -n`` is "up to N characters or the delimiter, whichever
        first" and ``read -N`` is "exactly N, delimiters included", which
        is this with ``delim`` None. The delimiter is consumed and not
        returned.

        Characters, not bytes: bash counts them in the shell's locale, so
        ``read -n 1`` on ``éx`` assigns ``é`` and leaves ``x``. Counting
        bytes would hand back half a character and leave the other half
        to corrupt the next read. UTF-8 is the only encoding mirage
        decodes, so a byte that starts no valid sequence counts as one
        character on its own, which is what the replacement character it
        decodes to occupies.

        Args:
            count (int): how many characters to read.
            delim (bytes | None): the stop, or None to read through
                delimiters.

        Returns:
            tuple[bytes, bool]: the bytes read and whether the read
            ended on its own terms (the count reached, or the delimiter
            seen) rather than at EOF.
        """
        out = bytearray()
        taken = 0
        need = max(len(delim) if delim is not None else 1, 4)
        while taken < count:
            # One pull can split a character or a multibyte delimiter
            # across chunks, so top the buffer up to the widest either
            # could be before reading its first byte as a whole one.
            if len(self._buf) < need and not self._exhausted:
                try:
                    self._buf += await self._source.__anext__()
                except StopAsyncIteration:
                    self._exhausted = True
                continue
            if not self._buf:
                return bytes(out), False
            if delim is not None and self._buf.startswith(delim):
                self._buf = self._buf[len(delim):]
                return bytes(out), True
            width = char_width(self._buf)
            out += self._buf[:width]
            self._buf = self._buf[width:]
            taken += 1
        return bytes(out), True
