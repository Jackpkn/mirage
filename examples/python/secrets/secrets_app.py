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

import asyncio
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.secrets import (SecretRef, SourceBlock, resolve_config_secrets,
                            resolve_sources)

load_dotenv(".env.development")

OP = SourceBlock(
    source="1password",
    config={
        "token": SecretRef(provider="env", key="OP_SERVICE_ACCOUNT_TOKEN")
    },
)

BOT = SecretRef(provider="op",
                ref="op://mirage/SLACK_BOT_TOKEN",
                key="credential")
USER = SecretRef(provider="op",
                 ref="op://mirage/SLACK_USER_TOKEN",
                 key="credential")

LINES = [
    "ls /remote | head -n 3",
    "ls /local | head -n 3",
    'echo "bot token: ${#SLACK_BOT_TOKEN} chars"',
    'echo "user token: ${#SLACK_USER_TOKEN} chars"',
    # A session write beats the pointer; a mount keeps its own token.
    "export SLACK_BOT_TOKEN=overridden-in-session",
    'echo "bot token now: $SLACK_BOT_TOKEN"',
    "ls /remote | head -n 1",
]


async def show(ws: Workspace, line: str) -> None:
    """Run one line and print what the agent would see.

    Args:
        ws (Workspace): the workspace to run in.
        line (str): the shell line.
    """
    result = await ws.execute(line)
    print(f"$ {line}")
    print(f"  exit {result.exit_code}")
    for stream, text in (("out", await
                          result.stdout_str()), ("err", await
                                                 result.stderr_str())):
        if text.strip():
            print(f"  {stream}: {text.strip()}")
    print()


async def main() -> None:
    sources = await resolve_sources({"op": OP})

    # A mount whose credentials come from 1Password. The pointers are
    # fetched here, so `SlackConfig` receives the tokens themselves.
    remote = await resolve_config_secrets({
        "token": BOT,
        "search_token": USER
    }, sources)

    # And one from the dotenv this process already loaded. Nothing
    # about the config differs; only where the string came from.
    local = {"token": os.environ["SLACK_BOT_TOKEN"]}

    ws = Workspace(
        {
            "/remote": SlackResource(config=SlackConfig(**remote)),
            "/local": SlackResource(config=SlackConfig(**local)),
        },
        mode=MountMode.READ,
        secrets={"op": OP},
        # The same pointers again as session variables, so one object
        # declares a mount credential and a variable.
        env={
            "SLACK_BOT_TOKEN": BOT,
            "SLACK_USER_TOKEN": USER
        },
    )
    for line in LINES:
        await show(ws, line)
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
