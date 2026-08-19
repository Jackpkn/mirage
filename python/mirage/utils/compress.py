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

import zlib
from collections.abc import AsyncIterator


async def gzip_compress_stream(
    source: AsyncIterator[bytes],
    level: int,
) -> AsyncIterator[bytes]:
    """Gzip a byte stream chunk by chunk.

    Args:
        source (AsyncIterator[bytes]): plain input chunks.
        level (int): zlib compression level.

    Yields:
        bytes: gzip member bytes, trailer included.
    """
    compressor = zlib.compressobj(level, zlib.DEFLATED, zlib.MAX_WBITS | 16)
    async for chunk in source:
        compressed = compressor.compress(chunk)
        if compressed:
            yield compressed
    tail = compressor.flush()
    if tail:
        yield tail


async def gzip_decompress_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Ungzip a byte stream chunk by chunk.

    Args:
        source (AsyncIterator[bytes]): gzip member chunks.

    Yields:
        bytes: the decompressed bytes.
    """
    decompressor = zlib.decompressobj(zlib.MAX_WBITS | 16)
    async for chunk in source:
        decompressed = decompressor.decompress(chunk)
        if decompressed:
            yield decompressed
    tail = decompressor.flush()
    if tail:
        yield tail
