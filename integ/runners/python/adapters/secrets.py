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

import os
import tempfile
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict

from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret


async def _noop() -> None:
    return None


class CounterConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class DeadConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


async def fetch_dead(config: DeadConfig, ref: str) -> ResolvedSecret:
    raise SecretsError("vault sealed")


def build_secrets_env(
        kind: str) -> tuple[dict[str, object], Callable[[], Awaitable[None]]]:
    """The env plane a secrets target declares, plus its cleanup.

    Registers the counting fake (fresh per-ref counters per open, so the
    counts inside fetched values are deterministic within one target
    run and prove how many times each secret was fetched), materializes
    the dotenv file the `dotenv` entry points at (its path exists only
    at run time, which is why the block is built here and not spelled
    in targets.json), and seeds the process variable the `env` entry
    reads. ``kind`` "dead" is a separate target on purpose: a whole-env
    command fetches every unfetched name, so one dead source would fail
    the healthy target's `env` case.

    Args:
        kind (str): "healthy" or "dead", the target's `secrets` value.
    """
    if kind == "dead":
        register_secrets("dead", DeadConfig, fetch_dead)
        return {
            "DEAD": {
                "from": "dead",
                "ref": "x"
            },
            "DEAD2": {
                "from": "dead",
                "ref": "y"
            },
        }, _noop
    counts: dict[str, int] = {}

    async def fetch_counting(config: CounterConfig,
                             ref: str) -> ResolvedSecret:
        counts[ref] = counts.get(ref, 0) + 1
        n = counts[ref]
        return ResolvedSecret(fields={
            "token": f"tok{n}",
            "user": f"u{n}",
            "pass": f"p{n}",
        })

    register_secrets("counter", CounterConfig, fetch_counting)
    os.environ["MIRAGE_INTEG_ENV_SECRET"] = "from-process-env"
    dotfile = tempfile.NamedTemporaryFile(mode="w",
                                          suffix=".env",
                                          delete=False)
    dotfile.write("DOTFILE_SECRET=from-dotenv\n")
    dotfile.close()

    async def cleanup() -> None:
        os.unlink(dotfile.name)

    env: dict[str, object] = {
        "APP_NAME": "integ",
        "EDITOR": {
            "value": "vi",
            "readonly": True
        },
        "TOKEN": {
            "from": "counter",
            "ref": "tok",
            "key": "token"
        },
        "DB_USER": {
            "from": "counter",
            "ref": "db",
            "key": "user"
        },
        "DB_PASS": {
            "from": "counter",
            "ref": "db",
            "key": "pass"
        },
        "EAGER_PAIR": {
            "from": "counter",
            "ref": "pair",
            "key": "token",
            "fetch": "eager"
        },
        "LAZY_PAIR": {
            "from": "counter",
            "ref": "pair",
            "key": "user"
        },
        "FROM_ENV": {
            "from": "env",
            "key": "MIRAGE_INTEG_ENV_SECRET"
        },
        "FROM_DOTFILE": {
            "from": "dotenv",
            "ref": dotfile.name,
            "key": "DOTFILE_SECRET"
        },
        "FN_TOKEN": {
            "from": "counter",
            "ref": "fn",
            "key": "token"
        },
        "IND_TOKEN": {
            "from": "counter",
            "ref": "ind",
            "key": "token"
        },
        "ALIAS_TOKEN": {
            "from": "counter",
            "ref": "alias",
            "key": "token"
        },
        "CLEAN_TOKEN": {
            "from": "counter",
            "ref": "clean",
            "key": "token"
        },
    }
    return env, cleanup
