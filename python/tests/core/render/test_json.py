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

from mirage.core.render.json import (compact_json_bytes, compact_json_text,
                                     json_bytes, json_text, jsonl_bytes)

# Byte-for-byte the fixture in the typescript twin
# (packages/core/src/core/render/json.test.ts). Both languages pin the same
# expected strings, so a change to either renderer breaks one of the two.
PAYLOAD = {
    "name": "café 中文",
    "tags": ["a", "b"],
    "meta": {
        "n": 1,
        "ok": True,
        "none": None
    },
    "empty": {},
}

INDENTED = ('{\n'
            '  "name": "café 中文",\n'
            '  "tags": [\n'
            '    "a",\n'
            '    "b"\n'
            '  ],\n'
            '  "meta": {\n'
            '    "n": 1,\n'
            '    "ok": true,\n'
            '    "none": null\n'
            '  },\n'
            '  "empty": {}\n'
            '}')

COMPACT = ('{"name":"café 中文","tags":["a","b"],'
           '"meta":{"n":1,"ok":true,"none":null},"empty":{}}')


def test_json_text_indents_two_and_keeps_non_ascii():
    assert json_text(PAYLOAD) == INDENTED


def test_json_bytes_indents_two_and_keeps_non_ascii():
    assert json_bytes(PAYLOAD) == INDENTED.encode()


def test_compact_json_text_has_no_separator_padding():
    assert compact_json_text(PAYLOAD) == COMPACT


def test_compact_json_bytes_encodes_the_text():
    assert compact_json_bytes(PAYLOAD) == COMPACT.encode()


def test_jsonl_bytes_terminates_every_row():
    assert jsonl_bytes([{"a": 1}, {"b": 2}]) == b'{"a":1}\n{"b":2}\n'


def test_jsonl_bytes_renders_no_rows_as_empty():
    assert jsonl_bytes([]) == b""


def test_jsonl_bytes_keeps_the_given_order():
    rows = [{"i": 2}, {"i": 1}]
    assert jsonl_bytes(rows) == b'{"i":2}\n{"i":1}\n'
