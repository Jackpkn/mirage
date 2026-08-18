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
"""cmp's byte counts, byte rendering and diagnostics, pinned on GNU 9.1."""
import pytest

from mirage.commands.builtin.generic.cmp import (cmp_cmd, parse_count,
                                                 parse_skip, visible)
from mirage.commands.errors import UsageError
from mirage.io.stream import materialize
from mirage.types import PathSpec

P1 = PathSpec.from_str_path("/F/one", "")
P2 = PathSpec.from_str_path("/F/two", "")


def _reader(first: bytes, second: bytes):

    async def read_bytes(path: PathSpec) -> bytes:
        return first if path.virtual == P1.virtual else second

    return read_bytes


async def _run(first: bytes, second: bytes, **kwargs):
    src, io = await cmp_cmd([P1, P2],
                            read_bytes=_reader(first, second),
                            **kwargs)
    out = b"" if src is None else await materialize(src)
    return out.decode(), (io.stderr or b"").decode(), io.exit_code


def test_parse_count_takes_digits_and_gnu_size_suffixes():
    assert parse_count("4", "--bytes") == 4
    assert parse_count("1K", "--bytes") == 1024
    assert parse_count("1kB", "--bytes") == 1000
    assert parse_count("1b", "--bytes") == 512


def test_parse_count_names_the_long_option_it_was_given():
    # GNU says `invalid --bytes value` for -n and `invalid
    # --ignore-initial value` for -i, with the Try-help line, exit 2.
    with pytest.raises(UsageError) as excinfo:
        parse_count("abc", "--bytes")
    assert str(excinfo.value) == ("cmp: invalid --bytes value 'abc'\n"
                                  "Try 'cmp --help' for more information.")
    assert excinfo.value.exit_code == 2


def test_parse_count_rejects_an_unknown_suffix():
    with pytest.raises(UsageError):
        parse_count("1Q", "--bytes")


def test_parse_skip_takes_one_count_for_both_files():
    assert parse_skip("3") == (3, 3)


def test_parse_skip_takes_a_colon_pair_for_one_each():
    assert parse_skip("0:3") == (0, 3)
    assert parse_skip("1K:2") == (1024, 2)


@pytest.mark.parametrize("byte,rendered", [
    (ord("b"), "b"),
    (9, "^I"),
    (1, "^A"),
    (127, "^?"),
    (0xC3, "M-C"),
    (0xA9, "M-)"),
    (0x80, "M-^@"),
])
def test_visible_renders_one_byte_the_cat_v_way(byte, rendered):
    assert visible(byte) == rendered


@pytest.mark.asyncio
async def test_print_bytes_switches_the_word_to_byte():
    # GNU counts in `byte` under -b and in `char` otherwise.
    plain, _, _ = await _run(b"abc", b"aXc")
    tagged, _, _ = await _run(b"abc", b"aXc", print_bytes=True)
    assert plain == "/F/one /F/two differ: char 2, line 1\n"
    assert tagged == ("/F/one /F/two differ: byte 2, line 1"
                      " is 142 b 130 X\n")


@pytest.mark.asyncio
async def test_verbose_pads_the_octal_to_three_columns():
    out, _, _ = await _run(b"a\x01c", b"a\x7fc", verbose=True)
    assert out == "2   1 177\n"


@pytest.mark.asyncio
async def test_verbose_with_print_bytes_adds_a_four_wide_char_column():
    out, _, _ = await _run(b"abc", b"aXc", verbose=True, print_bytes=True)
    assert out == "2 142 b    130 X\n"


@pytest.mark.asyncio
async def test_skip_is_applied_per_file():
    # `-i 0:3` keeps all of the first file and drops three bytes of the
    # second, so the very first compared byte differs.
    out, _, code = await _run(b"abcdefgh", b"abcXefgh", skip=(0, 3))
    assert out == "/F/one /F/two differ: char 1, line 1\n"
    assert code == 1


@pytest.mark.asyncio
async def test_eof_is_a_stderr_diagnostic_naming_the_byte_and_line():
    out, err, code = await _run(b"ab\nc", b"ab\ncdef")
    assert out == ""
    assert err == "cmp: EOF on /F/one after byte 4, in line 2\n"
    assert code == 1


@pytest.mark.asyncio
async def test_verbose_eof_reports_the_byte_without_the_line():
    out, err, code = await _run(b"aXc", b"aYcdef", verbose=True)
    assert out == "2 130 131\n"
    assert err == "cmp: EOF on /F/one after byte 3\n"
    assert code == 1


@pytest.mark.asyncio
async def test_a_limit_inside_the_common_prefix_reports_no_difference():
    assert await _run(b"abcdef", b"abcXef", limit=2) == ("", "", 0)
