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

from mirage.core.hierarchy.stat import entry_stat, make_stat
from mirage.core.trello.readdir import readdir
from mirage.core.trello.scope import detect_scope
from mirage.types import ContentType, FileType

stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "workspace": entry_stat("workspace_id", FileType.DIRECTORY),
        "workspace_json": entry_stat("workspace_id", ContentType.JSON),
        "board": entry_stat("board_id", FileType.DIRECTORY),
        "board_json": entry_stat("board_id", ContentType.JSON),
        "member": entry_stat("member_id", ContentType.JSON),
        "label": entry_stat("label_id", ContentType.JSON),
        "list": entry_stat("list_id", FileType.DIRECTORY),
        "list_json": entry_stat("list_id", ContentType.JSON),
        "card": entry_stat("card_id", FileType.DIRECTORY),
        "card_json": entry_stat("card_id", ContentType.JSON),
        "comments_jsonl": entry_stat("card_id", ContentType.TEXT),
    },
)
