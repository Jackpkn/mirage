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

import json
from typing import Any


def json_text(value: Any) -> str:
    """Render a value as indented JSON text.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return json.dumps(value, ensure_ascii=False, indent=2)


def json_bytes(value: Any) -> bytes:
    """Render a value as an indented .json body.

    Every backend renders a .json leaf through here, so read() and the
    readdir-time sizing produce the same bytes for the same payload and
    the advertised size is exact by construction.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return json_text(value).encode()


def compact_json_text(value: Any) -> str:
    """Render a value as a single line of JSON.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def compact_json_bytes(value: Any) -> bytes:
    """Render a value as a single-line JSON body.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return compact_json_text(value).encode()


def jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    """Render rows as line-delimited JSON, one compact object per line.

    An empty row list renders as empty bytes rather than a lone newline,
    so an empty .jsonl leaf sizes and reads as a zero-byte file.

    Args:
        rows (list[dict]): the rows to render, in output order.
    """
    if not rows:
        return b""
    lines = [compact_json_text(row) for row in rows]
    return ("\n".join(lines) + "\n").encode()
