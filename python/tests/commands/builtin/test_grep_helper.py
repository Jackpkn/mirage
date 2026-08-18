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

import re
from functools import partial

import pytest

from mirage.commands.builtin import grep_helper
from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat, to_pathspec)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read
from mirage.core.ram.readdir import readdir
from mirage.core.ram.stat import stat
from mirage.core.ram.write import write_bytes as _async_write_bytes
from mirage.types import FileStat, FileType, PathSpec

from mirage.commands.builtin.grep_helper import (  # isort: skip
    NEVER_MATCH, classify_pattern, compile_pattern, extract_required_literal,
    get_extension, grep_files_only, grep_lines, grep_recursive,
    merge_pattern_list, search_query)


def test_single_pattern_keeps_regex_semantics():
    pat = compile_pattern("fo+")
    assert pat.search("foo")
    assert not pat.search("f")


def test_single_fixed_string_escapes():
    pat = compile_pattern("a.b", fixed_string=True)
    assert pat.search("xa.by")
    assert not pat.search("axb")


def test_newline_separated_patterns_match_any():
    pat = compile_pattern("foo\nbar")
    assert pat.search("a foo b")
    assert pat.search("a bar b")
    assert not pat.search("baz")


def test_newline_separated_regex_alternation_grouping():
    pat = compile_pattern("ab+\ncd")
    assert pat.search("abb")
    assert pat.search("xcdy")
    assert not pat.search("ax")


def test_newline_separated_fixed_strings_escape_each():
    pat = compile_pattern("a.b\nc+", fixed_string=True)
    assert pat.search("xa.by")
    assert pat.search("c+")
    assert not pat.search("axb")
    assert not pat.search("cc")


def test_newline_separated_whole_word_applies_per_pattern():
    pat = compile_pattern("foo\nbar", whole_word=True)
    assert pat.search("a foo b")
    assert pat.search("bar.")
    assert not pat.search("foobar")


def test_newline_separated_ignore_case():
    pat = compile_pattern("foo\nbar", ignore_case=True)
    assert pat.search("FOO")
    assert pat.search("Bar")


def test_classify_pattern_newline_list_is_regex():
    assert classify_pattern("foo\nbar", False) == PatternType.REGEX
    assert classify_pattern("foo\nbar", True) == PatternType.REGEX
    assert classify_pattern("foo bar", False) == PatternType.SIMPLE


def test_merge_pattern_list_file_only():
    assert merge_pattern_list(None, b"foo\nbar\n") == "foo\nbar"


def test_merge_pattern_list_combines_flag_and_file():
    assert merge_pattern_list("x", b"y\nz\n") == "x\ny\nz"


def test_merge_pattern_list_no_file_keeps_pattern():
    assert merge_pattern_list("x", None) == "x"


def test_merge_pattern_list_empty_file_is_none():
    assert merge_pattern_list(None, b"") is None


def test_merge_pattern_list_blank_line_matches_all():
    assert merge_pattern_list(None, b"\n") == ""


def test_never_match_pattern_matches_nothing():
    pat = compile_pattern(NEVER_MATCH)
    assert not pat.search("")
    assert not pat.search("anything")


@pytest.mark.parametrize("pattern,expected", [
    ("import.*os", "import"),
    ("imp.*rt", "imp"),
    ("^import", "import"),
    ("colou?r", "colo"),
    ("[Ee]rror", "rror"),
    (r"\d+error", "error"),
    ("config$", "config"),
    ("a*b", None),
    ("ab", None),
    ("foo|bar", None),
    ("(ab)?cdef", "cdef"),
])
def test_extract_required_literal(pattern, expected):
    assert extract_required_literal(pattern) == expected


def test_extract_literal_is_required_substring():
    for pattern in ("import.*os", "colou?r", "[Ee]rror", r"\d+error"):
        literal = extract_required_literal(pattern)
        assert literal is not None
        for sample in ("import sys, os", "color", "colour", "Error here",
                       "an error", "x42error"):
            if re.search(pattern, sample):
                assert literal in sample


def test_search_query_literal_returns_pattern():
    assert search_query("import", False) == "import"
    assert search_query("foo", True) == "foo"


def test_search_query_regex_extracts_literal():
    assert search_query("import.*os", False) == "import"


def test_search_query_regex_no_literal_is_none():
    assert search_query("foo|bar", False) is None


@pytest.mark.asyncio
async def test_grep_files_only_recursive_scans_file_operands():
    # GNU: `grep -rl pat file` treats the operand as a file; only directory
    # operands are walked (search-narrowed candidates arrive as files).
    async def readdir_fn(path):
        raise FileNotFoundError(path)

    async def stat_fn(path):
        return FileStat(name=path, type=FileType.TEXT)

    async def read_bytes_fn(path):
        return b"alpha beta\n"

    hits = await grep_helper.grep_files_only(
        readdir_fn,
        stat_fn,
        read_bytes_fn,
        "/data/notes.txt",
        "alpha",
        recursive=True,
        ignore_case=False,
        invert=False,
        line_numbers=False,
        count_only=False,
        fixed_string=False,
        only_matching=False,
        max_count=None,
        whole_word=False,
        basic=True,
        warnings=[],
    )
    assert hits == ["/data/notes.txt"]


@pytest.mark.parametrize("pattern,fixed,expected", [
    ("abc", False, True),
    ("a-b_c.d", False, False),
    ("plain text", False, True),
    ("a.b", False, False),
    ("a*b", False, False),
    ("^start", False, False),
    ("a.b", True, True),
    ("a\nb", False, False),
    ("a\nb", True, True),
])
def test_is_literal_pattern(pattern, fixed, expected):
    assert grep_helper.is_literal_pattern(pattern, fixed) is expected


@pytest.mark.parametrize("flags,expected", [
    ({}, False),
    ({
        "i": True
    }, False),
    ({
        "F": True
    }, False),
    ({
        "r": True
    }, False),
    ({
        "v": True
    }, True),
    ({
        "n": True
    }, True),
    ({
        "c": True
    }, True),
    ({
        "args_l": True
    }, True),
    ({
        "w": True
    }, True),
    ({
        "o": True
    }, True),
    ({
        "q": True
    }, True),
    ({
        "H": True
    }, True),
    ({
        "h": True
    }, True),
    ({
        "m": "3"
    }, True),
    ({
        "A": "2"
    }, True),
    ({
        "B": "2"
    }, True),
    ({
        "C": "2"
    }, True),
])
def test_has_search_shaping_flags(flags, expected):
    assert grep_helper.has_search_shaping_flags(flags) is expected


def test_search_pushdown_ok_plain_literal():
    assert grep_helper.search_pushdown_ok({}, "ada") is True
    assert grep_helper.search_pushdown_ok({"i": True}, "ada") is True


def test_search_pushdown_ok_rejects_shaping_flag():
    assert grep_helper.search_pushdown_ok({"v": True}, "ada") is False
    assert grep_helper.search_pushdown_ok({"c": True}, "ada") is False


def test_search_pushdown_ok_rejects_regex_but_allows_fixed_string():
    assert grep_helper.search_pushdown_ok({}, "a.b") is False
    assert grep_helper.search_pushdown_ok({"F": True}, "a.b") is True


def _operand(virtual: str, pattern: str | None = None) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual.strip("/"),
                    pattern=pattern,
                    resolved=pattern is None)


TRACES = _operand("/traces")
SESSIONS = _operand("/sessions")


def test_pushdown_operand_admits_one_concrete_operand():
    assert grep_helper.pushdown_operand([TRACES], {}, "ada") is TRACES


def test_pushdown_operand_refuses_a_second_operand():
    # The bug this gate exists for: the push-down answered for the first
    # operand and dropped the rest in silence.
    assert grep_helper.pushdown_operand([TRACES, SESSIONS], {}, "ada") is None
    # Two operands in one family, which a per-operand push-down would have
    # answered twice over.
    assert grep_helper.pushdown_operand([TRACES, TRACES], {}, "ada") is None


def test_pushdown_operand_refuses_no_operand():
    assert grep_helper.pushdown_operand([], {}, "ada") is None


def test_pushdown_operand_refuses_glob_shaping_and_pattern_list():
    assert grep_helper.pushdown_operand([_operand("/traces/*", "*")], {},
                                        "ada") is None
    assert grep_helper.pushdown_operand([TRACES], {"c": True}, "ada") is None
    assert grep_helper.pushdown_operand([TRACES], {}, "ada\nbob") is None
    assert grep_helper.pushdown_operand([TRACES], {}, None) is None


def test_literal_pushdown_operand_adds_the_like_pattern_rule():
    assert grep_helper.literal_pushdown_operand([TRACES], {}, "ada") is TRACES
    # Everything pushdown_operand refuses, this refuses too.
    assert grep_helper.literal_pushdown_operand([TRACES, SESSIONS], {},
                                                "ada") is None
    assert grep_helper.literal_pushdown_operand([TRACES], {"c": True},
                                                "ada") is None
    # Plus the one it adds: LIKE matches a regex literally.
    assert grep_helper.literal_pushdown_operand([TRACES], {}, "a.b") is None
    assert grep_helper.literal_pushdown_operand([TRACES], {"F": True},
                                                "a.b") is TRACES


async def _write(backend, path, content):
    accessor = backend.accessor
    await _async_write_bytes(accessor, to_pathspec(path), content.encode())


async def _mkdir(backend, path):
    accessor = backend.accessor
    await mkdir(accessor, to_pathspec(path), parents=True)


def _bind(backend):
    accessor = backend.accessor
    backend.index
    return (
        partial(call_readdir, partial(readdir, accessor)),
        partial(call_stat, partial(stat, accessor)),
        partial(call_read_bytes, partial(read, accessor)),
    )


async def grep(backend, path, pattern, **kwargs):
    rd, st, rb = _bind(backend)
    recursive = kwargs.pop("recursive", False)
    ignore_case = kwargs.pop("ignore_case", False)
    invert = kwargs.pop("invert", False)
    line_numbers = kwargs.pop("line_numbers", False)
    count_only = kwargs.pop("count_only", False)
    files_only = kwargs.pop("files_only", False)
    fixed_string = kwargs.pop("fixed_string", False)
    only_matching = kwargs.pop("only_matching", False)
    max_count = kwargs.pop("max_count", None)
    whole_word = kwargs.pop("whole_word", False)
    show_filename = kwargs.pop("show_filename", None)
    warnings = kwargs.pop("warnings", None)
    # These helpers predate the BRE default, so they keep the extended
    # dialect their patterns were written in.
    basic = kwargs.pop("basic", False)

    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word,
                               basic)

    if recursive:
        results = await grep_recursive(
            rd,
            st,
            rb,
            path,
            compiled,
            invert,
            line_numbers,
            count_only,
            files_only,
            only_matching,
            max_count,
            warnings,
        )
        if show_filename is False and not count_only and not files_only:
            stripped = []
            for r in results:
                colon_idx = r.find(":")
                stripped.append(r[colon_idx + 1:] if colon_idx != -1 else r)
            return stripped
        return results

    return await grep_files_only(
        rd,
        st,
        rb,
        path,
        pattern,
        recursive=False,
        ignore_case=ignore_case,
        invert=invert,
        line_numbers=line_numbers,
        count_only=count_only,
        fixed_string=fixed_string,
        only_matching=only_matching,
        max_count=max_count,
        whole_word=whole_word,
        basic=basic,
        warnings=warnings,
    )


class TestCompilePattern:

    def test_basic(self):
        pat = compile_pattern("hello")
        assert pat.search("hello world")

    def test_ignore_case(self):
        pat = compile_pattern("hello", ignore_case=True)
        assert pat.search("HELLO")

    def test_fixed_string(self):
        pat = compile_pattern("a.b", fixed_string=True)
        assert not pat.search("axb")
        assert pat.search("a.b")

    def test_whole_word(self):
        pat = compile_pattern("foo", whole_word=True)
        assert not pat.search("foobar")
        assert pat.search("foo bar")


class TestGetExtension:

    def test_normal(self):
        assert get_extension("file.txt") == ".txt"

    def test_no_ext(self):
        assert get_extension("file") is None

    def test_directory_dot(self):
        assert get_extension("dir.d/file") is None


class TestGrepLines:

    def test_basic(self):
        compiled = compile_pattern("hello")
        result = grep_lines("/f.txt", ["hello world", "foo"], compiled, False,
                            False, False, False, False, None)
        assert result == ["hello world"]


class TestBasicMatching:

    @pytest.mark.anyio
    async def test_match_found(self, backend):
        await _write(backend, "/tmp/a.txt",
                     "hello world\nfoo bar\nhello again")
        result = await grep(backend, "/tmp/a.txt", "hello")
        assert result == ["/tmp/a.txt"]

    @pytest.mark.anyio
    async def test_no_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello world\nfoo bar")
        result = await grep(backend, "/tmp/a.txt", "xyz")
        assert result == []

    @pytest.mark.anyio
    async def test_empty_file(self, backend):
        await _write(backend, "/tmp/a.txt", "")
        result = await grep(backend, "/tmp/a.txt", "hello")
        assert result == []


class TestIgnoreCase:

    @pytest.mark.anyio
    async def test_ignore_case_matches(self, backend):
        await _write(backend, "/tmp/a.txt", "Hello World\nhello world\nHELLO")
        result = await grep(backend,
                            "/tmp/a.txt",
                            "hello",
                            ignore_case=True,
                            files_only=True)
        assert result == ["/tmp/a.txt"]


class TestInvert:

    @pytest.mark.anyio
    async def test_invert_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello\nworld\nhello again")
        result = await grep(backend,
                            "/tmp/a.txt",
                            "hello",
                            invert=True,
                            files_only=True)
        assert result == ["/tmp/a.txt"]


class TestCountOnly:

    @pytest.mark.anyio
    async def test_count_only(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo baz")
        result = await grep(backend, "/tmp/a.txt", "foo", count_only=True)
        assert result == ["2"]


class TestRecursive:

    @pytest.mark.anyio
    async def test_recursive_basic(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "hello world")
        result = await grep(backend, "/tmp", "hello", recursive=True)
        assert "/tmp/a.txt:hello" in result
        assert "/tmp/sub/b.txt:hello world" in result

    @pytest.mark.anyio
    async def test_recursive_with_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/b.txt", "x\nhello\ny")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            line_numbers=True)
        assert "/tmp/sub/b.txt:2:hello" in result

    @pytest.mark.anyio
    async def test_recursive_with_files_only(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "world")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            files_only=True)
        assert "/tmp/a.txt" in result
        assert "/tmp/sub/b.txt" not in result

    @pytest.mark.anyio
    async def test_recursive_with_count_only(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello\nhello")
        await _write(backend, "/tmp/sub/b.txt", "hello")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            count_only=True)
        assert len(result) > 0


class TestMixedFlags:

    @pytest.mark.anyio
    async def test_recursive_ignore_case_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/a.txt", "Hello\nworld")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            ignore_case=True,
                            line_numbers=True)
        assert "/tmp/sub/a.txt:1:Hello" in result


class TestShowFilename:

    @pytest.mark.anyio
    async def test_grep_hide_filename_recursive(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/a.txt", "needle")
        result = await grep(backend,
                            "/tmp/sub/",
                            "needle",
                            recursive=True,
                            show_filename=False)
        assert result == ["needle"]


class TestWarnings:

    @pytest.mark.anyio
    async def test_warnings_on_missing_file(self, backend):
        warnings = []
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            warnings=warnings)
        assert result == []
        assert len(warnings) > 0
        assert "nonexistent" in warnings[0]

    @pytest.mark.anyio
    async def test_warnings_none_does_not_error(self, backend):
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            warnings=None)
        assert result == []

    @pytest.mark.anyio
    async def test_missing_file_warns_once_in_gnu_wording(self, backend):
        warnings = []
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            files_only=True,
                            warnings=warnings)
        assert result == []
        assert warnings == [
            "grep: /tmp/nonexistent.txt: No such file or directory"
        ]

    @pytest.mark.anyio
    async def test_files_only_names_a_directory_without_walking_it(
            self, backend):
        """GNU descends only under -r; -l alone reports the operand.

        The directory holds a match, so a walk would put a filename on stdout.
        """
        await _mkdir(backend, "/tmp/walk")
        await _write(backend, "/tmp/walk/a.txt", "needle")
        warnings = []
        result = await grep(backend,
                            "/tmp/walk",
                            "needle",
                            files_only=True,
                            warnings=warnings)
        assert result == []
        assert warnings == ["grep: /tmp/walk: Is a directory"]

    @pytest.mark.anyio
    async def test_recursive_still_walks_a_directory(self, backend):
        """-r keeps the walk the no-flag case gives up.

        Calls grep_files_only itself rather than the shared harness, which
        routes recursive runs straight to grep_recursive and so would not
        reach the branch under test.
        """
        await _mkdir(backend, "/tmp/rwalk")
        await _write(backend, "/tmp/rwalk/a.txt", "needle")
        rd, st, rb = _bind(backend)
        warnings = []
        result = await grep_files_only(
            rd,
            st,
            rb,
            "/tmp/rwalk",
            "needle",
            recursive=True,
            ignore_case=False,
            invert=False,
            line_numbers=False,
            count_only=False,
            fixed_string=False,
            only_matching=False,
            max_count=None,
            whole_word=False,
            basic=False,
            warnings=warnings,
        )
        assert result == ["/tmp/rwalk/a.txt"]
        assert warnings == []


def _rules(*pairs: tuple[str, bool]) -> grep_helper.WalkFilters:
    return grep_helper.WalkFilters(file_globs=tuple(
        grep_helper.FileGlob(glob=glob, admit=admit) for glob, admit in pairs))


def test_file_admitted_resolves_rules_in_line_order():
    # Pinned against GNU grep 3.11: the last matching rule decides.
    inc_then_exc = _rules(("*.txt", True), ("*.txt", False))
    assert not grep_helper.file_admitted("/d/a.txt", inc_then_exc)
    exc_then_inc = _rules(("*.txt", False), ("*.txt", True))
    assert grep_helper.file_admitted("/d/a.txt", exc_then_inc)


def test_file_admitted_no_match_default_follows_the_first_rule():
    # GNU 3.11: a file matching no rule is admitted only when the
    # first rule is an exclude.
    exc_first = _rules(("*.log", False), ("*.zzz", True))
    assert grep_helper.file_admitted("/d/a.txt", exc_first)
    inc_first = _rules(("*.zzz", True), ("*.log", False))
    assert not grep_helper.file_admitted("/d/a.txt", inc_first)


def test_file_admitted_empty_rules_admit_everything():
    assert grep_helper.file_admitted("/d/a.bin", grep_helper.NO_FILTERS)


def test_parse_file_globs_reads_dests_in_typed_order():
    exc_first = FlagView({
        "exclude": ["notes.*"],
        "include": ["*.tex"]
    },
                         spec=SPECS["grep"])
    assert grep_helper.parse_file_globs(exc_first) == (
        grep_helper.FileGlob(glob="notes.*", admit=False),
        grep_helper.FileGlob(glob="*.tex", admit=True),
    )
    inc_first = FlagView({
        "include": ["*.tex"],
        "exclude": ["notes.*"]
    },
                         spec=SPECS["grep"])
    assert grep_helper.parse_file_globs(inc_first) == (
        grep_helper.FileGlob(glob="*.tex", admit=True),
        grep_helper.FileGlob(glob="notes.*", admit=False),
    )


EMAIL_HONORED = ("n", "args_l", "w", "o", "m")


def test_has_search_shaping_flags_exempts_only_the_named_dests():
    # gmail/slack/discord: the provider's search is word-based, so -w is what
    # makes the push-down faithful rather than what breaks it.
    assert not grep_helper.has_search_shaping_flags({"w": True}, ("w", ))
    assert grep_helper.has_search_shaping_flags({
        "w": True,
        "n": True
    }, ("w", ))
    # email: the local re-scan implements these, so they ride along.
    assert not grep_helper.has_search_shaping_flags(
        {
            "n": True,
            "o": True,
            "m": "3"
        }, EMAIL_HONORED)
    # ...but never -v or -c, which need messages the search did not return.
    assert grep_helper.has_search_shaping_flags({"v": True}, EMAIL_HONORED)
    assert grep_helper.has_search_shaping_flags({"c": True}, EMAIL_HONORED)


def test_honored_never_exempts_the_operand_rule():
    # An exemption is about flags only: two operands still defer.
    assert grep_helper.pushdown_operand([TRACES, SESSIONS], {"w": True}, "ada",
                                        ("w", )) is None
    assert grep_helper.pushdown_operand([TRACES], {"w": True}, "ada",
                                        ("w", )) is TRACES


def test_lone_operand_is_the_operand_rule_on_its_own():
    # email's find push-down has no grep pattern and no shaping flags.
    assert grep_helper.lone_operand([TRACES]) is TRACES
    assert grep_helper.lone_operand([TRACES, SESSIONS]) is None
    assert grep_helper.lone_operand([]) is None
    assert grep_helper.lone_operand([_operand("/traces/*", "*")]) is None
