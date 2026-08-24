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

from mirage.core.lancedb.query import _predicate


def test_narrows_on_a_name_prefix_with_a_cast():
    assert _predicate(
        "id", {},
        "doc-1") == ("CAST(`id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'")


def test_escapes_like_metacharacters_in_the_prefix():
    # An unescaped `_` is LIKE's single-character wildcard, so docX1 would
    # ride along and could crowd a real match out of the row cap.
    assert _predicate(
        "id", {},
        "doc_") == ("CAST(`id` AS STRING) LIKE 'doc\\_%' ESCAPE '\\'")
    assert _predicate(
        "id", {}, "a%") == ("CAST(`id` AS STRING) LIKE 'a\\%%' ESCAPE '\\'")


def test_ands_the_group_filters_with_the_prefix():
    assert _predicate("id", {"label": "cat"}, "doc-1") == (
        "`label` = 'cat' AND CAST(`id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'")


def test_quotes_a_column_name_a_bare_word_could_not_spell():
    # A space or a reserved word only parses quoted, and lance reads a
    # double-quoted word as a string literal, so the quotes are backticks.
    assert _predicate(
        "document id", {"select": "cat"},
        "doc-1") == ("`select` = 'cat' AND "
                     "CAST(`document id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'")


def test_is_the_filters_alone_with_no_prefix_and_empty_with_neither():
    assert _predicate("id", {"label": "cat"}, "") == "`label` = 'cat'"
    assert _predicate("id", {}, "") == ""
    assert _predicate("", {}, "doc-1") == ""
