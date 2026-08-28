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

import pytest

from mirage.core.hf_hub.mkdir import mkdir
from tests.core.hf_hub.conftest import ps


@pytest.mark.asyncio
async def test_mkdir_creates_nothing_and_does_not_raise(loaded):
    """A git tree records no empty directories, so there is no marker to
    write and nothing to ask the Hub for."""
    before = dict(loaded.tree)
    await mkdir(loaded, ps("newdir"))
    await mkdir(loaded, ps("a/b/c"), parents=True)
    assert loaded.tree == before
