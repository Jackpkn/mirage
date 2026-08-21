import pytest
from pydantic import ValidationError

from mirage.types import ContentType, FileStat, FileType


def test_file_carries_content():
    s = FileStat(name="a.txt", type=FileType.FILE, content=ContentType.TEXT)
    assert s.type is FileType.FILE
    assert s.content is ContentType.TEXT


def test_file_content_may_be_unknown():
    s = FileStat(name="a", type=FileType.FILE)
    assert s.content is None


def test_directory_has_no_content():
    s = FileStat(name="d", type=FileType.DIRECTORY)
    assert s.content is None


def test_symlink_has_no_content():
    s = FileStat(name="l", type=FileType.SYMLINK)
    assert s.content is None


_NON_FILE = [k for k in FileType if k is not FileType.FILE]


@pytest.mark.parametrize("kind", _NON_FILE)
def test_content_on_non_file_is_rejected(kind):
    with pytest.raises(ValidationError):
        FileStat(name="x", type=kind, content=ContentType.JSON)


@pytest.mark.parametrize("kind", _NON_FILE)
def test_non_file_kinds_construct_without_content(kind):
    # every declared kind is constructible (the not-yet-emitted device
    # kinds included), carrying no content.
    assert FileStat(name="x", type=kind).content is None


def test_full_posix_set_is_present():
    assert {k.name
            for k in FileType} == {
                "DIRECTORY", "FILE", "SYMLINK", "CHAR_DEVICE", "BLOCK_DEVICE",
                "FIFO", "SOCKET"
            }


def test_type_is_required():
    with pytest.raises(ValidationError):
        FileStat(name="x")


def test_enums_are_disjoint():
    # node kinds live only on FileType; content shapes only on ContentType
    assert not hasattr(ContentType, "DIRECTORY")
    assert not hasattr(ContentType, "SYMLINK")
    assert not hasattr(FileType, "JSON")
    assert not hasattr(FileType, "TEXT")
