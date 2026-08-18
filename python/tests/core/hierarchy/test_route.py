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

from mirage.core.hierarchy.route import match_route
from tests.core.hierarchy.conftest import ROUTES


def test_literal_and_capture_segments_match_in_order():
    matched = match_route(ROUTES, ["rooms", "red", "a.json"])
    assert matched is not None
    route, captures = matched
    assert route.kind == "note"
    assert captures == {"room": "red", "note": "a"}


def test_wrong_length_or_literal_is_no_match():
    assert match_route(ROUTES, ["halls"]) is None
    assert match_route(ROUTES, ["rooms", "red", "a.json", "deep"]) is None


def test_codec_failure_fails_the_whole_route():
    assert match_route(ROUTES, ["rooms", "red", "revisions",
                                "x.json"]) is None
    matched = match_route(ROUTES, ["rooms", "red", "revisions", "3.json"])
    assert matched is not None
    assert matched[1] == {"room": "red", "rev": "3"}


def test_validated_capture():
    assert match_route(ROUTES, ["tags", "ok"]) is not None
    assert match_route(ROUTES, ["tags", "NOPE"]) is None
