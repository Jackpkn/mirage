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

from dataclasses import replace

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.builtin.discord._provision import file_read_provision
from mirage.commands.builtin.discord.io import IO
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_generic, parse_flags
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.discord._client import discord_get
from mirage.core.discord.history import date_to_snowflake
from mirage.core.discord.read import read as discord_read
from mirage.core.discord.render import history_jsonl_bytes
from mirage.core.discord.scope import detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def head_provision(accessor: DiscordAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    line = "head " + " ".join(p.virtual for p in paths)
    return await file_read_provision(accessor, paths, texts,
                                     replace(opts, command=line))


@command("head",
         resource="discord",
         spec=SPECS["head"],
         provision=head_provision)
async def head(accessor: DiscordAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    lines = parsed.lines if parsed.lines is not None else 10
    if paths:
        scope = detect_scope(paths[0])

        # Smart head: fetch only first N messages for a single date. Only
        # counts one API page can honor (Discord caps limit at 100) take
        # the shortcut; zero, negative (all-but-last-N) and larger counts,
        # -v headers, byte counts and -z all keep the generic path.
        if (len(paths) == 1 and scope.level == "messages" and scope.channel_id
                and scope.date_str and parsed.bytes_ is None
                and not parsed.zero_terminated and not parsed.verbose
                and 0 < lines <= 100):
            after = date_to_snowflake(scope.date_str)
            before_int = int(date_to_snowflake(scope.date_str, end=True))
            msgs = await discord_get(
                accessor.config,
                f"/channels/{scope.channel_id}/messages",
                params={
                    "after": after,
                    "limit": lines
                },
            )
            assert isinstance(msgs, list)
            # With `after`, a short day spills into the next one: the API
            # keeps returning messages past midnight until `limit` is met,
            # so bound to the same end-of-day snowflake the readdir walk
            # uses or head would print lines chat.jsonl does not contain.
            msgs = [m for m in msgs if int(m["id"]) <= before_int]
            msgs.sort(key=lambda m: int(m["id"]))
            return generic_head(history_jsonl_bytes(msgs), n=lines), IOResult()
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    return await head_generic(resolved, list(texts), opts,
                              bound_op(IO.stat, accessor, opts.index),
                              bound_op(discord_read, accessor, opts.index))
