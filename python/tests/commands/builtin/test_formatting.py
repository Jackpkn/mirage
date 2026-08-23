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

import pytest

from mirage.commands.builtin.utils.formatting import (_human_size,
                                                      format_ls_long)
from mirage.types import ContentType, FileStat, FileType

# Read off GNU coreutils 9.7 (`ls -lh` on a file of each size, debian
# stable-slim). The three rows that matter are the ones a plain
# divide-and-format gets wrong: no suffix under 1024, rounding *up* to
# the shown precision (1025 -> 1.1K), and the decimal dropping once the
# value reaches ten (10240 -> 10K). 1048575 pins the carry: it ceils to
# 1024K, which GNU re-scales to 1.0M.
GNU_HUMAN_SIZES = [
    (0, "0"),
    (1, "1"),
    (24, "24"),
    (500, "500"),
    (999, "999"),
    (1000, "1000"),
    (1023, "1023"),
    (1024, "1.0K"),
    (1025, "1.1K"),
    (1126, "1.1K"),
    (1127, "1.2K"),
    (1536, "1.5K"),
    (2048, "2.0K"),
    (10188, "10K"),
    (10240, "10K"),
    (10241, "11K"),
    (11263, "11K"),
    (1048575, "1.0M"),
    (1048576, "1.0M"),
    (1024 * 1024 + 512 * 1024, "1.5M"),
    (1073741824, "1.0G"),
    # Past 2**53/10, so a `n * 10` intermediate stops being exact.
    # GNU says 1.8P; a float product rounds down and yields 1.7P.
    (1914029841632461, "1.8P"),
]


@pytest.mark.parametrize(("size", "expected"), GNU_HUMAN_SIZES)
def test_human_size_matches_gnu(size: int, expected: str):
    assert _human_size(size) == expected


def test_format_ls_long_regular_file():
    stat = FileStat(name="file.txt",
                    size=5,
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    modified="2026-01-01T00:00:00Z")
    [line] = format_ls_long([stat])
    assert line == "-rw-r--r-- 1 user user 5 Jan  1 00:00 file.txt"


def test_format_ls_long_directory():
    stat = FileStat(name="sub",
                    size=0,
                    type=FileType.DIRECTORY,
                    modified="2026-01-01T00:00:00Z")
    [line] = format_ls_long([stat])
    assert line.startswith("drwxr-xr-x ")
    assert line.endswith(" sub")


def test_format_ls_long_size_alignment():
    stats = [
        FileStat(name="a",
                 size=5,
                 type=FileType.FILE,
                 content=ContentType.TEXT,
                 modified="2026-01-01T00:00:00Z"),
        FileStat(name="b",
                 size=1234,
                 type=FileType.FILE,
                 content=ContentType.TEXT,
                 modified="2026-01-01T00:00:00Z"),
    ]
    lines = format_ls_long(stats)
    assert "    5 Jan  1 00:00 a" in lines[0]
    assert " 1234 Jan  1 00:00 b" in lines[1]


def test_format_ls_long_human_size():
    stat = FileStat(name="big",
                    size=2048,
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    modified="2026-01-01T00:00:00Z")
    [line] = format_ls_long([stat], human=True)
    assert "2.0K" in line
    assert " 2048 " not in line


def test_format_ls_long_missing_modified():
    stat = FileStat(name="x",
                    size=0,
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    modified=None)
    [line] = format_ls_long([stat])
    assert "Jan  1 00:00" in line
