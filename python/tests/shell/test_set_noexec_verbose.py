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

# Pinned against GNU bash 5.2.37 on debian:stable-slim.
NOEXEC = [
    ("set -n; echo hi", ""),
    ("echo a; set -n; echo b; echo c", "a\n"),
    # One-way within the same input: `set +n` is itself a statement, so
    # it never runs. GNU behaves the same way.
    ("set -n; set +n; echo after", ""),
    ("echo a; set -o noexec; echo b", "a\n"),
    ("echo a; echo b", "a\nb\n"),
]

VERBOSE = [
    # The unit is an input line, not a statement: the line that turned
    # the option on was already read, so nothing is echoed for it.
    ("set -v; echo hi", "hi\n", ""),
    ("set -v; echo a; set +v; echo b", "a\nb\n", ""),
    ("set -v\necho a\necho b", "a\nb\n", "echo a\necho b\n"),
    # `set +v` is echoed because the option is still on when its line
    # reaches the reader; the line after it is not.
    ("set -v\necho a\nset +v\necho b", "a\nb\n", "echo a\nset +v\n"),
    # A statement spanning several lines carries all of them.
    ("set -v\nfor i in 1 2; do\n echo $i\ndone", "1\n2\n",
     "for i in 1 2; do\n echo $i\ndone\n"),
]


@pytest.mark.parametrize("cmd,out", NOEXEC)
def test_noexec(shell, cmd, out):
    assert shell.mirage(cmd) == out


@pytest.mark.parametrize("cmd,out,err", VERBOSE)
def test_verbose(shell, cmd, out, err):
    _, got_out, got_err = shell.mirage_result(cmd)
    assert got_out == out
    assert got_err == err


def test_option_listing_matches_gnu_defaults(shell):
    text = shell.mirage("set -o")
    # The three GNU turns on for a non-interactive shell, and nothing else.
    on = [ln.split()[0] for ln in text.splitlines() if ln.endswith("on")]
    assert on == ["braceexpand", "hashall", "interactive-comments"]
    assert text.startswith("allexport      \toff\n")
    assert "interactive-comments\ton\n" in text


def test_plus_o_listing_is_re_readable(shell):
    text = shell.mirage("set +o")
    assert text.startswith("set +o allexport\nset -o braceexpand\n")
    assert "set +o xtrace\n" in text


def test_brace_expansion_follows_its_option(shell):
    assert shell.mirage("echo {a,b}") == "a b\n"
    assert shell.mirage("set +B; echo {a,b}") == "{a,b}\n"
    assert "braceexpand    \toff\n" in shell.mirage("set +B; set -o")
