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

from mirage.commands.cli.builtin.hf.auth import list_cmd, whoami_cmd
from mirage.commands.errors import UsageError
from mirage.io.types import materialize
from tests.commands.cli.builtin.hf.conftest import ANON, inv


async def _text(result) -> str:
    source, _ = result
    return (await materialize(source)).decode()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.auth.whoami")
async def test_whoami_prints_the_account_and_its_orgs(mock_whoami):
    mock_whoami.return_value = {"name": "zoe", "orgs": [{"name": "acme"}]}
    assert await _text(await whoami_cmd(inv())) == "zoe\nacme\n"


@pytest.mark.asyncio
async def test_whoami_refuses_without_a_token():
    """The Hub answers 401 'Invalid username or password.' for an
    anonymous call, which reads as a wrong credential, not a missing
    one."""
    with pytest.raises(UsageError):
        await whoami_cmd(inv(config=ANON))


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.auth.whoami")
async def test_auth_list_reports_the_one_install_credential(mock_whoami):
    """A workspace has no token store; an install carries exactly one
    credential, so the list is that one and never more."""
    mock_whoami.return_value = {"name": "zoe"}
    text = await _text(await list_cmd(inv()))
    assert text.splitlines()[0].split() == ["NAME", "TOKEN"]
    assert text.splitlines()[1].startswith("zoe")
    assert "hf_test" not in text


@pytest.mark.asyncio
async def test_auth_list_is_just_a_header_without_a_token():
    text = await _text(await list_cmd(inv(config=ANON)))
    assert len(text.splitlines()) == 1
