import pytest

from mirage.core.nextcloud.du import stat_or_null
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_stat_or_null_returns_the_row_for_a_file(make_acc):
    acc = make_acc({"data/a.json": b"12345"})
    info = await stat_or_null(acc, PathSpec.from_str_path("/data/a.json"))
    assert info is not None
    assert info.size == 5


@pytest.mark.asyncio
async def test_stat_or_null_returns_the_row_for_a_directory(make_acc):
    acc = make_acc({"data/a.json": b"12345"})
    info = await stat_or_null(acc, PathSpec.from_str_path("/data"))
    assert info is not None
    assert info.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_or_null_answers_none_for_a_missing_path(make_acc):
    acc = make_acc({})
    assert await stat_or_null(acc, PathSpec.from_str_path("/nope")) is None
