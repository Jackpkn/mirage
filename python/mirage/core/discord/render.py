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

from typing import Any

from mirage.core.render.json import compact_json_bytes, jsonl_bytes


def history_jsonl_bytes(messages: list[dict[str, Any]]) -> bytes:
    """Render a channel-day's messages as JSONL.

    Args:
        messages (list[dict]): message dicts, oldest first.
    """
    return jsonl_bytes(messages)


def member_json_bytes(member: dict[str, Any]) -> bytes:
    """Render one guild member as JSON.

    Args:
        member (dict): guild member dict as returned by the members API.
    """
    return compact_json_bytes(member)
