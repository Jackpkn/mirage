import errno
from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.client import get_document_segments, iter_segment_pages
from mirage.core.dify.path import resolve_path
from mirage.types import PathSpec
from mirage.utils.ranges import slice_window


async def read_bytes(accessor: DifyAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read a document, optionally only a byte range of it.

    A document is rendered here from its segments, so its bytes do not
    exist until we make them and the window can only be taken
    afterwards, the same way the rendered branches of gdrive, slack and
    discord take theirs.

    Args:
        accessor (DifyAccessor): Dify accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the entry.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    segments = await get_document_segments(accessor, resolved.entry.id)
    return slice_window(segments_to_bytes(segments), offset, size)


async def read_stream(
        accessor: DifyAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX) -> AsyncIterator[bytes]:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    first = True
    async for page in iter_segment_pages(accessor, resolved.entry.id):
        for segment in page:
            if first:
                first = False
            else:
                yield b"\n"
            yield segment_text(segment).encode()


def segments_to_bytes(segments: list[dict[str, Any]]) -> bytes:
    return "\n".join(segment_text(segment) for segment in segments).encode()


def segment_text(segment: dict[str, Any]) -> str:
    value = segment.get("content")
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)
