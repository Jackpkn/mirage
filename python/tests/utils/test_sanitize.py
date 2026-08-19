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

from mirage.utils.sanitize import sanitize_label


def test_sanitize_label_replaces_unsafe_and_spaces():
    assert sanitize_label("Hello World", fallback="X",
                          max_len=100) == "Hello_World"
    assert sanitize_label("My/Doc: A\\Test", fallback="X",
                          max_len=100) == "My_Doc_A_Test"


def test_sanitize_label_collapses_and_trims_underscores():
    assert sanitize_label("Hello   //  World", fallback="X",
                          max_len=100) == "Hello_World"
    assert sanitize_label("__edge__", fallback="X", max_len=100) == "edge"


def test_sanitize_label_uses_fallback_for_blank():
    assert sanitize_label("", fallback="Untitled", max_len=100) == "Untitled"
    assert sanitize_label("   ", fallback="No_Subject",
                          max_len=80) == "No_Subject"


def test_sanitize_label_ellipsizes_past_budget():
    result = sanitize_label("x" * 120, fallback="X", max_len=100)
    assert len(result) == 100
    assert result.endswith("...")
    assert sanitize_label("x" * 100, fallback="X", max_len=100) == "x" * 100


def test_sanitize_label_keeps_non_ascii_letters():
    # `\w` is unicode-aware in python, and the shared typescript regex spells
    # the same class as `\p{L}\p{N}_`. The per-backend copies this replaced
    # used a javascript `\w`, which is ascii-only and turned a CJK title into
    # a row of underscores.
    assert sanitize_label("日本語の文書", fallback="X", max_len=100) == "日本語の文書"
    assert sanitize_label("Café Notes", fallback="X",
                          max_len=100) == "Café_Notes"
