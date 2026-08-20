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

from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len, sanitize_label


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


def test_sanitize_label_budget_counts_code_points():
    # The typescript twin measured `String.length`, which counts UTF-16 units:
    # 50 ascii plus 26 astral letters reads as 102 there and 76 here. This is
    # the input that made it truncate a label python leaves whole.
    label = "a" * 50 + "\U00010400" * 26
    assert sanitize_label(label, fallback="X", max_len=100) == label


def test_sanitize_label_ellipsizes_on_code_point_boundary():
    # A byte budget wide enough to stay out of the way, so this pins the
    # character budget alone.
    label = "\U00010400" * 120
    result = sanitize_label(label, fallback="X", max_len=100, max_bytes=10_000)
    assert len(result) == 100
    assert result.endswith("...")
    assert "\ufffd" not in result


def test_sanitize_label_honors_the_byte_ceiling_within_the_char_budget():
    # 100 astral code points is 400 bytes, so a name the character budget
    # accepts is one ext4 and APFS reject with ENAMETOOLONG. The default
    # budget is NAME_MAX, and the cut still lands on a code-point boundary.
    label = "\U00010400" * 120
    result = sanitize_label(label, fallback="X", max_len=100)
    assert len(result) < 100
    assert byte_len(result) <= NAME_MAX_BYTES
    assert result.endswith("...")
    assert "\ufffd" not in result


def test_sanitize_label_byte_budget_is_the_callers_remaining_room():
    # What the gdocs/gmail filenames pass: NAME_MAX minus the id, the
    # separators and the suffix.
    result = sanitize_label("会" * 200, fallback="X", max_len=100, max_bytes=60)
    assert byte_len(result) <= 60
    assert result.endswith("...")
    assert "\ufffd" not in result


def test_sanitize_label_drops_the_ellipsis_when_it_cannot_fit():
    # Three dots and nothing is not a name; a budget this small yields
    # whatever of the label actually fits.
    assert sanitize_label("abcdef", fallback="X", max_len=100,
                          max_bytes=2) == "ab"
