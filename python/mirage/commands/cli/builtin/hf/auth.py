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

from mirage.commands.cli.builtin.hf.accessor import require_token, text_out
from mirage.commands.cli.types import CLIInvocation
from mirage.core.hf_hub.account import whoami
from mirage.core.hf_hub.config import HfConfig
from mirage.io.types import ByteSource, IOResult


async def whoami_cmd(
        inv: CLIInvocation[HfConfig]) -> tuple[ByteSource | None, IOResult]:
    """Print the account the configured token belongs to."""
    require_token(inv, "auth whoami")
    account = await whoami(inv.config)
    name = account.get("name")
    orgs = account.get("orgs")
    lines = [str(name) if isinstance(name, str) else ""]
    for org in orgs if isinstance(orgs, list) else []:
        if isinstance(org, dict) and isinstance(org.get("name"), str):
            lines.append(str(org["name"]))
    return text_out("\n".join(lines) + "\n")


async def list_cmd(
        inv: CLIInvocation[HfConfig]) -> tuple[ByteSource | None, IOResult]:
    """List the stored access tokens.

    A workspace has no token store: an install carries exactly one
    credential, given to it by the embedding program. So this reports
    that one under upstream's own two-column shape rather than pretending
    to a set it cannot hold, and reports nothing when there is none.
    """
    rows = ["{:<20} {}".format("NAME", "TOKEN")]
    if inv.config.token is not None:
        account = await whoami(inv.config)
        name = account.get("name")
        rows.append("{:<20} {}".format(
            str(name) if isinstance(name, str) else "install", "*" * 8))
    return text_out("\n".join(rows) + "\n")
