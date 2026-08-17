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

from unittest.mock import patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.core.dropbox.watch import DropboxWalk
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def _accessor(root_path: str) -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


def _root() -> PathSpec:
    return PathSpec(virtual="/m", directory="/m", resource_path="")


async def _collect(walk, root):
    return [entry async for entry in walk(root)]


@pytest.mark.asyncio
async def test_server_casing_of_the_root_is_still_stripped() -> None:
    # Dropbox paths are case-insensitive: path_display carries the
    # server's casing and root_path the user's. Comparing them exactly
    # left the root on the front of every virtual path, which put every
    # event outside the watch scope and silently disabled delivery.
    listing = [{
        ".tag": "file",
        "path_display": "/Team/notes.txt",
        "path_lower": "/team/notes.txt",
        "size": 4,
        "rev": "r1",
    }]
    with patch("mirage.core.dropbox.watch.list_folder", return_value=listing):
        entries = await _collect(DropboxWalk(_accessor("/team")), _root())
    assert [e.virtual for e in entries] == ["/m/notes.txt"]


@pytest.mark.asyncio
async def test_casing_below_the_root_is_preserved() -> None:
    listing = [{
        ".tag": "file",
        "path_display": "/Team/Notes/Report.TXT",
        "path_lower": "/team/notes/report.txt",
        "size": 4,
        "rev": "r1",
    }]
    with patch("mirage.core.dropbox.watch.list_folder", return_value=listing):
        entries = await _collect(DropboxWalk(_accessor("/team")), _root())
    assert [e.virtual for e in entries] == ["/m/Notes/Report.TXT"]
