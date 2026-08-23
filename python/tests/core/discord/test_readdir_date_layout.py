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

import aiohttp
import pytest

from mirage.core.discord.readdir import readdir
from mirage.types import PathSpec
from tests.core.discord.conftest import BROKEN_DAY, DAY, SEALED_DAY

pytestmark = pytest.mark.asyncio

CHANNEL = "My Server__G001/channels/general__C001"


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.lstrip("/"))


async def test_date_dir_contents_lists_chat_and_files(api, accessor, index):
    result = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"), index)
    assert result == [
        f"/{CHANNEL}/{DAY}/chat.jsonl",
        f"/{CHANNEL}/{DAY}/files",
    ]


async def test_files_dir_lists_attachments(api, accessor, index):
    result = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"), index)
    assert result == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]


async def test_fetch_day_swallows_soft_errors(api, accessor, index):
    # A 403/404/429 seals an empty day rather than failing the listing.
    result = await readdir(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}"), index)
    assert result == []


async def test_fetch_day_propagates_hard_errors(api, accessor, index):
    with pytest.raises(aiohttp.ClientResponseError):
        await readdir(accessor, spec(f"/{CHANNEL}/{BROKEN_DAY}"), index)


async def test_files_under_a_sealed_day_is_enoent(api, accessor, index):
    # The sealed day lists nothing, so its files subdir does not exist.
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}/files"), index)
