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
from unittest.mock import AsyncMock

import pytest

from mirage.io import IOResult
from mirage.shell import parse
from mirage.shell.helpers import get_parts
from mirage.workspace.expand.parts import expand_parts, expand_words
from mirage.workspace.session import Session


def _words(cmd: str, env=None, stdout: bytes = b""):
    parts = get_parts(parse(cmd).named_children[0])
    session = Session(session_id="t", cwd="/", env=env or {})
    execute_fn = AsyncMock(return_value=IOResult(stdout=stdout))
    return asyncio.run(expand_words(parts, session, execute_fn))


@pytest.mark.parametrize("cmd,text,globbable", [
    ("c /data/*.txt", "/data/*.txt", True),
    ("c '/data/*.txt'", "/data/*.txt", False),
    ('c "/data/*.txt"', "/data/*.txt", False),
    ("c /data/\\*.txt", "/data/*.txt", False),
    ("c '/data/?.txt'", "/data/?.txt", False),
    ("c '/data/[a].txt'", "/data/[a].txt", False),
    ("c $'/data/*.txt'", "/data/*.txt", False),
    ("c /data/a.txt", "/data/a.txt", False),
])
def test_word_globbability_by_quoting(cmd, text, globbable):
    word = _words(cmd)[1]
    assert word.text == text
    assert word.globbable is globbable


@pytest.mark.parametrize("cmd,text,globbable", [
    ('c "/data/"*.txt', "/data/*.txt", True),
    ("c '/data/*'.txt", "/data/*.txt", False),
    ("c '/data/'x\\*.txt", "/data/x*.txt", False),
    ('c "/data/*"?.txt', "/data/*?.txt", True),
])
def test_concatenation_is_live_when_any_child_is(cmd, text, globbable):
    word = _words(cmd)[1]
    assert word.text == text
    assert word.globbable is globbable


def test_unquoted_expansion_value_is_live():
    word = _words("c $p", env={"p": "/data/*.txt"})[1]
    assert word.text == "/data/*.txt"
    assert word.globbable is True


def test_quoted_expansion_value_is_literal():
    word = _words('c "$p"', env={"p": "/data/*.txt"})[1]
    assert word.text == "/data/*.txt"
    assert word.globbable is False


def test_expansion_without_glob_chars_is_not_live():
    word = _words("c $p", env={"p": "/data/a.txt"})[1]
    assert word.globbable is False


def test_command_substitution_words_are_live():
    words = _words("c $(inner)", stdout=b"*.txt plain")
    assert [(w.text, w.globbable) for w in words[1:]] == [("*.txt", True),
                                                          ("plain", False)]


def test_brace_quoted_alternative_stays_literal():
    words = _words("c {'*',x}")
    assert [(w.text, w.globbable) for w in words[1:]] == [("*", False),
                                                          ("x", False)]


def test_brace_literal_template_glob_is_live():
    words = _words("c {a,b}*")
    assert [(w.text, w.globbable) for w in words[1:]] == [("a*", True),
                                                          ("b*", True)]


def test_brace_unquoted_expansion_atom_is_live():
    words = _words("c {$p,x}", env={"p": "*.txt"})
    assert [(w.text, w.globbable) for w in words[1:]] == [("*.txt", True),
                                                          ("x", False)]


def test_expand_parts_returns_the_same_texts():
    cmd = "c '/data/*.txt' \"/data/\"*.txt {a,b}*"
    parts = get_parts(parse(cmd).named_children[0])
    session = Session(session_id="t", cwd="/", env={})
    execute_fn = AsyncMock(return_value=IOResult())
    words = asyncio.run(expand_words(parts, session, execute_fn))
    texts = asyncio.run(expand_parts(parts, session, execute_fn))
    assert texts == [w.text for w in words]
