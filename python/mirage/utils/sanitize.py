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

import re

UNSAFE_CHARS = re.compile(r"[^\w\s\-.]")
MULTI_UNDERSCORE = re.compile(r"_+")
MAX_LEN = 100
# POSIX NAME_MAX on ext4 and APFS alike, and it counts BYTES. Truncating by
# characters is the same number only for ASCII: a 100-character CJK title is
# 300 bytes.
NAME_MAX_BYTES = 255


def truncate_bytes(text: str, budget: int) -> str:
    """Trim a string to fit a byte budget without splitting a character.

    Args:
        text (str): the string to trim.
        budget (int): maximum length in UTF-8 bytes.

    Returns:
        str: ``text`` unchanged when it already fits, else the longest
        prefix whose UTF-8 encoding is at most ``budget`` bytes.
    """
    if budget <= 0:
        return ""
    raw = text.encode("utf-8")
    if len(raw) <= budget:
        return text
    # errors="ignore" drops the partial sequence the cut may have left,
    # which is exactly the trailing character that did not fit.
    return raw[:budget].decode("utf-8", errors="ignore")


def sanitize_name(name: str) -> str:
    """Sanitize a name for use in virtual paths.

    Replaces shell-unsafe characters (apostrophes, quotes, etc.)
    and spaces with underscores. Safe for use in shell commands
    without quoting.

    Args:
        name (str): raw name from API.

    Returns:
        str: sanitized name.
    """
    if not name.strip():
        return "unknown"
    cleaned = UNSAFE_CHARS.sub("_", name)
    cleaned = cleaned.replace(" ", "_")
    cleaned = MULTI_UNDERSCORE.sub("_", cleaned)
    cleaned = cleaned.strip("_")
    if len(cleaned) > MAX_LEN:
        cleaned = cleaned[:MAX_LEN]
    return cleaned


def path_safe_name(name: str) -> str:
    """Make a name safe to embed in a VFS path segment.

    Preserves the original spelling (spaces, apostrophes, emoji, etc.)
    and only replaces the path separator ``/`` with ``∕`` (U+2215)
    so the value cannot collide with a directory boundary. Use this
    for resource directory and file names where keeping the original
    display name matters more than shell ergonomics.

    Args:
        name (str): raw name from API.

    Returns:
        str: path-safe name, or "unknown" if empty.
    """
    if not name.strip():
        return "unknown"
    return name.replace("/", "∕")


def sanitize_label(text: str, *, fallback: str, max_len: int) -> str:
    """Sanitize an API-supplied label for use inside a filename.

    The shared body behind every backend's title/subject sanitizer:
    replace shell-unsafe characters and spaces with underscores, collapse
    the runs, trim the edges, then ellipsize past the budget. Backends
    differ only in what an empty label becomes and how long a label may
    be, so those are the arguments.

    Unlike ``sanitize_name`` this ellipsizes rather than hard-cutting, so
    a truncated name reads as truncated.

    Args:
        text (str): raw label from the API.
        fallback (str): what an empty or whitespace-only label becomes.
        max_len (int): budget in characters; a longer label keeps its
            first ``max_len - 3`` characters plus an ellipsis.

    Returns:
        str: the sanitized label.
    """
    if not text.strip():
        return fallback
    cleaned = UNSAFE_CHARS.sub("_", text).replace(" ", "_")
    cleaned = MULTI_UNDERSCORE.sub("_", cleaned).strip("_")
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len - 3] + "..."
    return cleaned
