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

from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.scope import Scope, Slot, match_scope
from tests.core.hierarchy.conftest import SCOPES, detect_scope, spec

ID_SCOPES = (Scope(kind="file",
                   segments=("owned",
                             Slot("name",
                                  Codec(suffix=".json"),
                                  id_key="file_id")),
                   leaf=True), )


def test_literal_and_slot_segments_match_in_order():
    matched = match_scope(SCOPES, ["rooms", "red", "a.json"])
    assert matched is not None
    scope, slots = matched
    assert scope.kind == "note"
    assert slots == {"room": "red", "note": "a"}


def test_wrong_length_or_literal_is_no_match():
    assert match_scope(SCOPES, ["halls"]) is None
    assert match_scope(SCOPES, ["rooms", "red", "a.json", "deep"]) is None


def test_codec_failure_fails_the_whole_scope():
    assert match_scope(SCOPES, ["rooms", "red", "revisions", "x.json"]) is None
    matched = match_scope(SCOPES, ["rooms", "red", "revisions", "3.json"])
    assert matched is not None
    assert matched[1] == {"room": "red", "rev": "3"}


def test_validated_slot():
    assert match_scope(SCOPES, ["tags", "ok"]) is not None
    assert match_scope(SCOPES, ["tags", "NOPE"]) is None


def test_id_key_splits_on_the_last_separator():
    matched = match_scope(ID_SCOPES, ["owned", "2024-01-05_Notes__abc12.json"])
    assert matched is not None
    assert matched[1] == {"name": "2024-01-05_Notes", "file_id": "abc12"}
    # A three-part label keeps everything before the LAST separator.
    matched = match_scope(ID_SCOPES, ["owned", "KEY__name__id7.json"])
    assert matched is not None
    assert matched[1] == {"name": "KEY__name", "file_id": "id7"}


def test_id_key_requires_both_halves():
    assert match_scope(ID_SCOPES, ["owned", "plain.json"]) is None
    assert match_scope(ID_SCOPES, ["owned", "__id.json"]) is None
    assert match_scope(ID_SCOPES, ["owned", "label__.json"]) is None


def test_empty_key_is_root():
    assert detect_scope("").kind == "root"
    assert detect_scope("/").kind == "root"


def test_pathspec_operand_uses_the_mount_path():
    match = detect_scope(spec("/rooms/red"))
    assert match.kind == "room"
    assert match.slots == {"room": "red"}


def test_hidden_segments_are_invalid_anywhere():
    assert detect_scope("rooms/.red").kind == "invalid"
    assert detect_scope(".rooms").kind == "invalid"


def test_unmatched_shapes_are_invalid():
    assert detect_scope("rooms/red/a.json/deep").kind == "invalid"
    assert detect_scope("halls").kind == "invalid"


def test_match_carries_the_scope():
    match = detect_scope("rooms/red/a.json")
    assert match.scope is not None
    assert match.scope.leaf
    assert detect_scope("").scope is None
