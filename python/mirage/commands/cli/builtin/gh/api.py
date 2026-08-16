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

import json
import re

from mirage.commands.cli.builtin.gh.accessor import json_out, text_out
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.github._client import github_request
from mirage.core.github.config import GhConfig
from mirage.core.github.placeholder import expand
from mirage.core.jq import jq_eval
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

INT_RE = re.compile(r"^-?\d+$")
READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def typed(value: str) -> JsonValue:
    """Read a `-F` value as the JSON type it spells.

    `-f` is always a string; `-F` reads `true`, `false`, `null` and integers
    as their JSON types, which is gh's own split between `--raw-field` and
    `--field`.

    Args:
        value (str): the value as typed.

    Returns:
        JsonValue: the value as its JSON type.
    """
    if value == "true":
        return True
    if value == "false":
        return False
    if value == "null":
        return None
    if INT_RE.match(value):
        return int(value)
    return value


def jq_line(value: JsonValue) -> str:
    """One `--jq` output the way gh renders it, probed against 2.85.

    A string prints raw, null prints as an empty line (where jq's own
    `-r` would print the word), and every other value prints as compact
    JSON. Each output ends its own line.

    Args:
        value (JsonValue): one value the jq program emitted.

    Returns:
        str: the line's body, without its newline.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def split(pair: str) -> tuple[str, str]:
    """Split one `key=value`, keeping every `=` after the first.

    Args:
        pair (str): the field as typed.

    Returns:
        tuple[str, str]: the key and the value.

    Raises:
        ValueError: the field holds no `=`.
    """
    key, sep, value = pair.partition("=")
    if not sep:
        raise ValueError(f'expected "key=value", got "{pair}"')
    return key, value


async def api(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    endpoint = inv.texts[0] if inv.texts else ""
    if not endpoint:
        raise ValueError("an API endpoint is required")
    fields: dict[str, JsonValue] = {}
    for pair in fl.as_list("raw_field"):
        key, value = split(pair)
        fields[key] = value
    for pair in fl.as_list("field"):
        key, value = split(pair)
        # gh expands a placeholder in a `-F` value but not in a `-f` one,
        # which its own --help spells out and a live 2.85 confirms.
        fields[key] = typed(expand(value, inv.config))
    # gh sends a body-bearing call as POST unless --method says otherwise,
    # and a bare one as GET.
    method = fl.as_str("method") or ("POST" if fields else "GET")
    endpoint = expand(endpoint, inv.config)
    path = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    upper = method.upper()
    # `api` is one leaf for both halves of the API, so whether it wrote is
    # on the line rather than in the spec: a GET must not expire every
    # github mount the install serves.
    mutated = upper not in READ_METHODS
    # A GET carries its fields in the query string, everything else in a
    # JSON body; with no fields there is neither, so a bare DELETE has no
    # body.
    if upper == "GET":
        params = {k: _query(v) for k, v in fields.items()}
        result = await github_request(inv.config.token,
                                      upper,
                                      path,
                                      params=params or None,
                                      base_url=inv.config.base_url)
    else:
        result = await github_request(inv.config.token,
                                      upper,
                                      path,
                                      fields or None,
                                      base_url=inv.config.base_url)
    # `--jq` filters the response client-side, exactly as real gh does; a
    # failing request never reaches it. Deliberate divergence: a bad or
    # failing program is reported in mirage's jq engine's words, not
    # gojq's, with the same exit code.
    program = fl.as_str("jq")
    if program:
        lines = "".join(f"{jq_line(v)}\n" for v in jq_eval(result, program))
        return text_out(lines, mutated)
    return json_out(result, mutated)


def _query(value: JsonValue) -> str:
    """One field as a query-string value.

    Args:
        value (JsonValue): the field value.

    Returns:
        str: its query-string spelling.
    """
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return str(value)
