from mirage.commands.resolve import get_extension


def test_get_extension_normal():
    assert get_extension("file.txt") == ".txt"


def test_get_extension_no_ext():
    assert get_extension("file") is None


def test_get_extension_directory_dot():
    assert get_extension("dir.d/file") is None
