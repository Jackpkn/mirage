from mirage.commands.builtin.find_helper import (expand_printf,
                                                 printf_needs_stat,
                                                 unrespell_raw)
from mirage.types import FileStat, FileType, PathSpec


def _spec(virtual: str, raw: str | None = None) -> PathSpec:
    return PathSpec(resource_path=virtual.strip("/"),
                    virtual=virtual,
                    directory=virtual,
                    resolved=True,
                    raw_path=raw if raw is not None else virtual)


def _stat(size: int = 6, file_type: FileType = FileType.TEXT) -> FileStat:
    return FileStat(name="a",
                    size=size,
                    type=file_type,
                    modified="2026-08-16T13:45:30+00:00")


def test_printf_needs_stat():
    assert printf_needs_stat("%s\n")
    assert printf_needs_stat("%TY\n")
    assert not printf_needs_stat("%p %f %h %P %d\n")
    assert not printf_needs_stat("100%%score\n")


def test_unrespell_raw_round_trip():
    assert unrespell_raw("./sub/x", "/data", ".") == "/data/sub/x"
    assert unrespell_raw(".", "/data", ".") == "/data"
    assert unrespell_raw("/data/x", "/data", "/data") == "/data/x"


def test_expand_path_directives():
    warnings: list[str] = []
    search = _spec("/data")
    row = "/data/sub/b.txt"
    assert expand_printf(
        "%p|%P|%f|%h|%d\n", row, search, None,
        warnings) == "/data/sub/b.txt|sub/b.txt|b.txt|/data/sub|2\n"
    assert warnings == []


def test_expand_stat_directives():
    warnings: list[str] = []
    search = _spec("/data")
    out = expand_printf("%s %y %m %M\n", "/data/a.txt", search, _stat(),
                        warnings)
    assert out == "6 f 644 -rw-r--r--\n"
    dir_out = expand_printf("%y %m\n", "/data/sub", search,
                            _stat(0, FileType.DIRECTORY), warnings)
    assert dir_out == "d 755\n"


def test_expand_time_directives():
    warnings: list[str] = []
    search = _spec("/data")
    assert expand_printf("%TY-%Tm-%Td\n", "/data/a.txt", search, _stat(),
                         warnings) == "2026-08-16\n"
    epoch = expand_printf("%T@\n", "/data/a.txt", search, _stat(), warnings)
    assert epoch == "1786887930.0000000000\n"
    assert len(epoch.strip().split(".")[1]) == 10


def test_expand_escapes_and_unknown():
    warnings: list[str] = []
    search = _spec("/data")
    assert expand_printf("A\\tB\\n", "/data/a.txt", search, None,
                         warnings) == "A\tB\n"
    assert expand_printf("%Q\n", "/data/a.txt", search, None,
                         warnings) == "%Q\n"
    assert warnings == ["find: warning: unrecognized format directive '%Q'"]
    expand_printf("%Q %Q\n", "/data/a.txt", search, None, warnings)
    assert len(warnings) == 1


def test_expand_root_row():
    warnings: list[str] = []
    search = _spec("/data")
    assert expand_printf("%P|%d|%f\n", "/data", search, None,
                         warnings) == "|0|data\n"
