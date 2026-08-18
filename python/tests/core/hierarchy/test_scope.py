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

from tests.core.hierarchy.conftest import detect_scope, spec


def test_empty_key_is_root():
    assert detect_scope("").kind == "root"
    assert detect_scope("/").kind == "root"


def test_pathspec_operand_uses_the_mount_path():
    match = detect_scope(spec("/rooms/red"))
    assert match.kind == "room"
    assert match.captures == {"room": "red"}


def test_hidden_segments_are_invalid_anywhere():
    assert detect_scope("rooms/.red").kind == "invalid"
    assert detect_scope(".rooms").kind == "invalid"


def test_unmatched_shapes_are_invalid():
    assert detect_scope("rooms/red/a.json/deep").kind == "invalid"
    assert detect_scope("halls").kind == "invalid"


def test_match_carries_the_route():
    match = detect_scope("rooms/red/a.json")
    assert match.route is not None
    assert match.route.leaf
    assert detect_scope("").route is None
