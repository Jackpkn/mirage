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

from mirage.core.hierarchy.codec import (INT_JSON, JSON_NAME, JSONL_NAME, RAW,
                                         ascii_digits)


def test_raw_takes_any_nonempty_segment():
    assert RAW.decode("anything") == "anything"
    assert RAW.decode("") is None


def test_json_name_strips_the_suffix_and_refuses_bare_ones():
    assert JSON_NAME.decode("trace1.json") == "trace1"
    assert JSON_NAME.decode("trace1.jsonl") is None
    assert JSON_NAME.decode(".json") is None
    assert JSON_NAME.decode("noext") is None
    assert JSON_NAME.encode("trace1") == "trace1.json"


def test_jsonl_name_is_the_jsonl_twin():
    assert JSONL_NAME.decode("run.jsonl") == "run"
    assert JSONL_NAME.decode("run.json") is None


def test_int_json_requires_plain_ascii_digits():
    assert INT_JSON.decode("12.json") == "12"
    assert INT_JSON.decode("007.json") == "007"
    # int() would accept these; parseInt would guess at the first; both
    # languages must refuse them identically.
    assert INT_JSON.decode("12abc.json") is None
    assert INT_JSON.decode("1.5.json") is None
    assert INT_JSON.decode("١٢.json") is None


def test_ascii_digits_guard():
    assert ascii_digits("42")
    assert not ascii_digits("4x2")
    assert not ascii_digits("")
