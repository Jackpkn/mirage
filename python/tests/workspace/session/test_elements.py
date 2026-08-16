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

import asyncio

import pytest

from mirage.shell.errors import ArithError
from mirage.shell.variable import VarAttr, with_attr
from mirage.types import HiddenVars
from mirage.workspace.session import Session
from mirage.workspace.session.elements import (assign_element, element_index,
                                               element_is_set,
                                               session_elements,
                                               strip_key_quotes)
from mirage.workspace.session.state import seed_var


def _session() -> Session:
    session = Session(session_id="s", cwd="/")
    seed_var(session, "m", {"a": "1", "k5": "9", "0": "z"})
    seed_var(session, "arr", ["10", "20", "30"])
    seed_var(session, "s5", "5")
    seed_var(session, "i", "1")
    return session


def test_strip_key_quotes():
    assert strip_key_quotes('"x"') == "x"
    assert strip_key_quotes("'x'") == "x"
    assert strip_key_quotes("x") == "x"
    assert strip_key_quotes('"x') == '"x'
    assert strip_key_quotes('""') == ""


def test_element_index_int_arith_and_error():
    assert element_index("3", {}) == 3
    assert element_index(" -2 ", {}) == -2
    assert element_index("i+1", {"i": "1"}) == 2
    # An unresolvable expression indexes element 0, bash's
    # unset-name-is-zero arithmetic rule.
    assert element_index("$bad", {}) == 0


def test_resolve_assoc_is_literal():
    session = _session()
    ops = session_elements(session)
    assert ops.resolve("m", "a", {}) == "a"
    assert ops.resolve("m", '"a"', {}) == "a"
    # A key spelled like arithmetic stays a key.
    assert ops.resolve("m", "1+1", {}) == "1+1"


def test_resolve_indexed_evaluates_and_wraps_negative():
    session = _session()
    ops = session_elements(session)
    assert ops.resolve("arr", "1+1", {}) == "2"
    assert ops.resolve("arr", "i", {"i": "2"}) == "2"
    assert ops.resolve("arr", "-1", {}) == "2"
    with pytest.raises(ArithError):
        ops.resolve("arr", "-9", {})


def test_read_by_kind():
    session = _session()
    ops = session_elements(session)
    assert ops.read("m", "a") == "1"
    assert ops.read("m", "zz") is None
    assert ops.read("arr", "1") == "20"
    assert ops.read("arr", "9") is None
    # A scalar answers as element 0 of a one-element array.
    assert ops.read("s5", "0") == "5"
    assert ops.read("s5", "1") is None
    assert ops.read("missing", "0") is None


def test_element_is_set():
    session = _session()
    assert element_is_set(session, "m[a]")
    assert not element_is_set(session, "m[zz]")
    # The subscript is the key verbatim, never arithmetic.
    assert not element_is_set(session, "m[1+1]")
    assert element_is_set(session, "m[@]")
    assert element_is_set(session, "arr[2]")
    assert not element_is_set(session, "arr[9]")
    assert element_is_set(session, "arr[@]")
    # A bare name over an array checks element 0 (the literal key "0"
    # for an associative one).
    assert element_is_set(session, "m")
    assert element_is_set(session, "arr")
    assert element_is_set(session, "s5")
    assert not element_is_set(session, "missing")
    assert not element_is_set(session, "not a ref")


def test_assign_element_assoc_and_append():
    session = _session()

    async def run():
        assert await assign_element(session, None, "m", "b", "2") == "ok"
        assert await assign_element(session, None, "m", "b", "x",
                                    append=True) == "ok"
        # A bare target over an associative array is the key "0".
        assert await assign_element(session, None, "m", None, "top") == "ok"
        assert await assign_element(session, None, "m", "", "v") == "subscript"

    asyncio.run(run())
    assert session.assocs["m"]["b"] == "2x"
    assert session.assocs["m"]["0"] == "top"


def test_assign_element_indexed_scalar_and_statuses():
    session = _session()
    session.vars["ro"] = with_attr(session.vars.pop("s5"), VarAttr.READONLY)
    session.hidden_vars = HiddenVars(names=("h", ), patterns=())

    async def run():
        assert await assign_element(session, None, "arr", "1", "X") == "ok"
        assert await assign_element(session, None, "arr", "-1", "Y") == "ok"
        assert await assign_element(session, None, "arr", "-9",
                                    "n") == "subscript"
        # An existing scalar migrates to element 0 under a subscript.
        seed_var(session, "sc", "base")
        assert await assign_element(session, None, "sc", "1", "one") == "ok"
        assert await assign_element(session, None, "ro", "0",
                                    "x") == "readonly"
        assert await assign_element(session, None, "h", "0", "x") == "denied"

    asyncio.run(run())
    assert session.arrays["arr"] == ["10", "X", "Y"]
    assert session.arrays["sc"] == ["base", "one"]
