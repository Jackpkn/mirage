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

# Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
CASES = [
    # `>` onto an existing target is refused and the target is intact.
    ("echo a > /data/f; set -C; echo b > /data/f; echo rc=$?; cat /data/f", 1,
     "rc=1\na\n", "/data/f: cannot overwrite existing file\n"),
    # Existence is the test, not size: an empty file still refuses.
    (": > /data/f; set -C; echo b > /data/f; echo rc=$?", 1, "rc=1\n",
     "/data/f: cannot overwrite existing file\n"),
    # `>|` overrides for one redirect, and does not clear the option.
    ("echo a > /data/f; set -C; echo b >| /data/f; echo rc=$?; cat /data/f", 0,
     "rc=0\nb\n", ""),
    ("echo a > /data/f; set -C; echo b >| /data/f; echo c > /data/f;"
     " echo rc=$?", 1, "rc=1\n", "/data/f: cannot overwrite existing file\n"),
    # A new target and `>>` are both allowed.
    ("set -C; echo b > /data/new; echo rc=$?; cat /data/new", 0, "rc=0\nb\n",
     ""),
    ("echo a > /data/f; set -C; echo b >> /data/f; echo rc=$?; cat /data/f", 0,
     "rc=0\na\nb\n", ""),
    # `2>` and `&>` are refused the same way.
    ("echo a > /data/f; set -C; ls /nope 2> /data/f; echo rc=$?; cat /data/f",
     1, "rc=1\na\n", "/data/f: cannot overwrite existing file\n"),
    ("echo a > /data/f; set -C; echo b &> /data/f; echo rc=$?; cat /data/f", 1,
     "rc=1\na\n", "/data/f: cannot overwrite existing file\n"),
    # bash stops at the first refused open: one message, neither written.
    ("echo a > /data/x; echo a > /data/y; set -C;"
     " echo b > /data/x > /data/y; echo rc=$?; cat /data/x /data/y", 1,
     "rc=1\na\na\n", "/data/x: cannot overwrite existing file\n"),
    # A directory under the option answers in GNU's wording for that case.
    ("mkdir -p /data/d; set -C; echo b > /data/d; echo rc=$?", 1, "rc=1\n",
     "/data/d: Is a directory\n"),
    # The letter and the long name are the same option, and `+C` clears it.
    ("echo a > /data/f; set -o noclobber; echo b > /data/f; echo rc=$?", 1,
     "rc=1\n", "/data/f: cannot overwrite existing file\n"),
    ("echo a > /data/f; set -C; set +C; echo b > /data/f; echo rc=$?;"
     " cat /data/f", 0, "rc=0\nb\n", ""),
    # Off by default: the ordinary overwrite is untouched.
    ("echo a > /data/f; echo b > /data/f; echo rc=$?; cat /data/f", 0,
     "rc=0\nb\n", ""),
]


@pytest.mark.parametrize("cmd,last_rc,out,err", CASES)
def test_noclobber(shell, cmd, last_rc, out, err):
    _, got_out, got_err = shell.mirage_result(cmd)
    assert got_out == out
    assert got_err == err
    assert f"rc={last_rc}" in got_out or last_rc == 0


def test_noclobber_shows_in_the_option_listing(shell):
    # The fixture reuses one session across calls, so the default is
    # asserted before anything sets the option.
    assert "noclobber      \toff\n" in shell.mirage("set -o")
    assert "noclobber      \ton\n" in shell.mirage("set -C; set -o")
    assert "set -o noclobber\n" in shell.mirage("set +o")
