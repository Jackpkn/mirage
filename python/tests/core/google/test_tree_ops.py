from unittest.mock import AsyncMock

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.google.tree_ops import make_stat, make_unlink
from mirage.types import PathSpec
from mirage.utils.errors import enoent

DEEP = "/owned/sub/missing.json"


async def readdir_absent(_accessor, path, index=None):
    """Stand in for a readdir whose directory does not exist.

    Args:
        path (PathSpec): the parent directory being listed.
    """
    raise enoent(path.virtual)


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure():
    readdir = AsyncMock(side_effect=RuntimeError("google unavailable"))
    stat = make_stat(readdir)

    with pytest.raises(RuntimeError, match="google unavailable"):
        await stat(None, PathSpec.from_str_path("/owned/missing.json"),
                   RAMIndexCacheStore())


@pytest.mark.asyncio
async def test_unlink_propagates_parent_refresh_failure():
    readdir = AsyncMock(side_effect=RuntimeError("google unavailable"))
    unlink = make_unlink(readdir)

    with pytest.raises(RuntimeError, match="google unavailable"):
        await unlink(None, PathSpec.from_str_path("/owned/missing.json"),
                     RAMIndexCacheStore())


@pytest.mark.asyncio
async def test_stat_names_the_operand_when_the_parent_is_absent():
    stat = make_stat(readdir_absent)

    with pytest.raises(FileNotFoundError) as excinfo:
        await stat(None, PathSpec.from_str_path(DEEP), RAMIndexCacheStore())
    assert str(excinfo.value) == DEEP


@pytest.mark.asyncio
async def test_unlink_names_the_operand_when_the_parent_is_absent():
    unlink = make_unlink(readdir_absent)

    with pytest.raises(FileNotFoundError) as excinfo:
        await unlink(None, PathSpec.from_str_path(DEEP), RAMIndexCacheStore())
    assert str(excinfo.value) == DEEP
