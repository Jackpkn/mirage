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
import json
import tempfile
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.workspace.session.ram import RAMSessionStore

# Two dotenv files stand in for two accounts. Nothing here is real, so
# the script prints the values it fetches -- an example against a live
# store would print a length or a prefix instead.
#
# Run it unbuffered (`python -u`, which is what the truth file does):
# one line of host log lands on stderr as it happens, and only an
# unbuffered stdout puts it where it belongs rather than at the end.
VAULT = """API_TOKEN=demo-token-abc123
DB_PASSWORD=demo-pw-xyz789
"""

FETCHED = ("demo-token-abc123", "demo-pw-xyz789")


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
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp) / "vault.env"
        vault.write_text(VAULT)
        store = RAMSessionStore()
        ws = Workspace(
            {"/data": RAMResource()},
            mode=MountMode.WRITE,
            session_store=store,
            # One instance per account. `dotenv` needs only a path, so
            # both configs are literals; a source that needs a
            # credential would read it here through {from: env, ...}.
            secrets={
                "vault": {
                    "source": "dotenv",
                    "config": {
                        "path": str(vault)
                    },
                },
                "gone": {
                    "source": "dotenv",
                    "config": {
                        "path": str(Path(tmp) / "absent.env")
                    },
                },
            },
            env={
                "API_TOKEN": {
                    "from": "vault",
                    "key": "API_TOKEN"
                },
                "DB_PASSWORD": {
                    "from": "vault",
                    "key": "DB_PASSWORD"
                },
                "MISSING": {
                    "from": "gone",
                    "key": "MISSING"
                },
                "MIRAGE_ENV": {
                    "value": "demo"
                },
            },
        )

        print("=== a literal costs no fetch ===")
        await show(ws, 'echo "env is $MIRAGE_ENV"')

        print("=== a line naming no secret fetches nothing ===")
        await show(ws, "echo hello > /data/note.txt; cat /data/note.txt")

        print("=== the value arrives for the line that reads it ===")
        await show(ws, 'echo "token: $API_TOKEN"')

        print("=== one source per instance: a dead one fails its own "
              "lines only ===")
        await show(ws, 'echo "missing: $MISSING"')
        await show(ws, 'echo "and this line still runs: $DB_PASSWORD"')

        # The one property worth seeing: `env` holds the literal, and
        # `managed` holds the pointer. Both fetched values were on the
        # session a moment ago and neither reached the store, so a
        # restored session starts declared-but-unfetched again.
        print("=== what the session persisted ===")
        record = next(iter((await store.load()).values()))
        print("env:")
        for name, value in sorted((record.get("env") or {}).items()):
            print(f"  {name}={value}")
        print("managed (the pointer, never the value):")
        for name, ref in sorted((record.get("managed") or {}).items()):
            print(f"  {name} from {ref['from']}, key {ref['key']}")
        stored = json.dumps(record)
        leaked = any(value in stored for value in FETCHED)
        print(f"\na fetched value reached the store: "
              f"{'yes' if leaked else 'no'}")

        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
