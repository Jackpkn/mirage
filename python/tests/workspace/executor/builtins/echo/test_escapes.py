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

from mirage.workspace.executor.builtins.echo import interpret_escapes


def test_newline():
    assert interpret_escapes("a\\nb") == "a\nb"


def test_tab():
    assert interpret_escapes("a\\tb") == "a\tb"


def test_carriage_return():
    assert interpret_escapes("\\r") == "\r"


def test_bell():
    assert interpret_escapes("\\a") == "\a"


def test_backspace():
    assert interpret_escapes("\\b") == "\b"


def test_form_feed():
    assert interpret_escapes("\\f") == "\f"


def test_vertical_tab():
    assert interpret_escapes("\\v") == "\v"


def test_literal_backslash():
    assert interpret_escapes("a\\\\b") == "a\\b"


def test_double_backslash_before_n():
    assert interpret_escapes("\\\\n") == "\\n"


def test_double_backslash_before_b():
    assert interpret_escapes("a\\\\b") == "a\\b"


def test_hex_escape():
    assert interpret_escapes("\\x41") == "A"


def test_hex_single_digit():
    assert interpret_escapes("\\x9") == "\t"


def test_hex_no_digits():
    assert interpret_escapes("\\x") == "\\x"


def test_octal_escape():
    assert interpret_escapes("\\0101") == "A"


def test_octal_null():
    assert interpret_escapes("\\0") == "\0"


def test_stop_output():
    assert interpret_escapes("hello\\cworld") == "hello"


def test_unknown_escape_passthrough():
    assert interpret_escapes("\\z") == "\\z"


def test_no_escapes():
    assert interpret_escapes("hello world") == "hello world"


def test_empty():
    assert interpret_escapes("") == ""


def test_trailing_backslash():
    assert interpret_escapes("end\\") == "end\\"


def test_mixed():
    assert interpret_escapes("a\\tb\\nc\\\\d") == "a\tb\nc\\d"
