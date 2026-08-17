import errno
from collections.abc import AsyncIterator

from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.client import iter_page_chunks, page_chunks
from mirage.core.chroma.path import resolve_path
from mirage.core.chroma.render import render_page
from mirage.types import PathSpec


async def read_bytes(
    accessor: ChromaAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    chunks = await page_chunks(accessor, resolved.entry.extra["slug"])
    return render_page(chunks)


async def read_stream(
    accessor: ChromaAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    first = True
    async for chunk in iter_page_chunks(accessor,
                                        resolved.entry.extra["slug"]):
        if first:
            first = False
        else:
            yield b"\n"
        yield chunk.encode()
