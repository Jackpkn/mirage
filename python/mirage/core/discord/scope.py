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

import re
from dataclasses import dataclass

from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class DiscordScope:
    """Resolved scope for a discord path.

    Attributes:
        level (str): one of ``root``, ``guild``, ``channel``, ``date``,
            ``messages``, ``files``, ``file_blob``, ``member``.
        use_native (bool): whether native guild search may serve this scope.
        guild_name (str | None): display half of the guild dirname.
        guild_id (str | None): guild snowflake parsed from the dirname.
        channel_name (str | None): display half of the channel dirname.
        channel_id (str | None): channel snowflake parsed from the dirname.
        member_name (str | None): display half of the member filename.
        member_id (str | None): user snowflake parsed from the filename.
        container (str | None): ``channels`` or ``members``.
        date_str (str | None): ``YYYY-MM-DD`` for date-level and below.
        resource_path (str): resource-relative key (prefix stripped).
    """

    level: str
    use_native: bool
    guild_name: str | None = None
    guild_id: str | None = None
    channel_name: str | None = None
    channel_id: str | None = None
    member_name: str | None = None
    member_id: str | None = None
    container: str | None = None
    date_str: str | None = None
    resource_path: str = "/"


def _split_dirname(dirname: str) -> tuple[str, str | None]:
    if "__" in dirname:
        name, _, cid = dirname.rpartition("__")
        return name, cid or None
    return dirname, None


def detect_scope(path: PathSpec) -> DiscordScope:
    """Determine scope from a path.

    IDs come straight out of the ``name__id`` dirnames the tree mints, so
    detection is pure and needs no index or network round-trip; a bare
    name without ``__id`` yields ``None`` ids and the caller falls back
    to the scan. Mirrors the TypeScript ``detectScope``.

    Examples::

        /                                              → root
        /<guild>                                       → guild
        /<guild>/channels                              → guild
        /<guild>/members                               → guild
        /<guild>/channels/<ch>                         → channel
        /<guild>/members/<user>.json                   → member
        /<guild>/channels/<ch>/<date>                  → date
        /<guild>/channels/<ch>/<date>/chat.jsonl       → messages
        /<guild>/channels/<ch>/<date>/files            → files
        /<guild>/channels/<ch>/<date>/files/<blob>     → file_blob
    """

    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""

    if path.pattern and path.pattern.endswith(".jsonl"):
        dir_key = path.directory.strip("/")
        if prefix:
            dir_key = dir_key.removeprefix(prefix.strip("/") + "/")
        dp = dir_key.split("/") if dir_key else []
        if len(dp) == 3 and dp[1] == "channels" and dp[0] and dp[2]:
            guild_name, guild_id = _split_dirname(dp[0])
            channel_name, channel_id = _split_dirname(dp[2])
            return DiscordScope(
                level="channel",
                use_native=True,
                guild_name=guild_name,
                guild_id=guild_id,
                channel_name=channel_name,
                channel_id=channel_id,
                container="channels",
                resource_path=dir_key,
            )
        if (len(dp) == 4 and dp[1] == "channels" and dp[0] and dp[2]
                and _DATE_RE.match(dp[3])):
            guild_name, guild_id = _split_dirname(dp[0])
            channel_name, channel_id = _split_dirname(dp[2])
            return DiscordScope(
                level="messages",
                use_native=True,
                guild_name=guild_name,
                guild_id=guild_id,
                channel_name=channel_name,
                channel_id=channel_id,
                container="channels",
                date_str=dp[3],
                resource_path=dir_key,
            )

    key = path.resource_path
    if not key:
        return DiscordScope(level="root", use_native=True, resource_path="/")

    parts = key.split("/")

    if len(parts) == 1:
        guild_name, guild_id = _split_dirname(parts[0])
        return DiscordScope(
            level="guild",
            use_native=True,
            guild_name=guild_name,
            guild_id=guild_id,
            resource_path=key,
        )

    if len(parts) == 2:
        guild_name, guild_id = _split_dirname(parts[0])
        if parts[1] in ("channels", "members"):
            return DiscordScope(
                level="guild",
                use_native=parts[1] == "channels",
                guild_name=guild_name,
                guild_id=guild_id,
                container=parts[1],
                resource_path=key,
            )
        return DiscordScope(
            level="guild",
            use_native=False,
            guild_name=guild_name,
            guild_id=guild_id,
            resource_path=key,
        )

    if len(parts) == 3:
        guild_name, guild_id = _split_dirname(parts[0])
        if parts[1] == "channels":
            channel_name, channel_id = _split_dirname(parts[2])
            return DiscordScope(
                level="channel",
                use_native=True,
                guild_name=guild_name,
                guild_id=guild_id,
                channel_name=channel_name,
                channel_id=channel_id,
                container="channels",
                resource_path=key,
            )
        if parts[1] == "members":
            member_name, member_id = _split_dirname(
                parts[2].removesuffix(".json"))
            return DiscordScope(
                level="member",
                use_native=False,
                guild_name=guild_name,
                guild_id=guild_id,
                member_name=member_name,
                member_id=member_id,
                container="members",
                resource_path=key,
            )

    # /<guild>/channels/<ch>/<date>
    if (len(parts) == 4 and parts[1] == "channels"
            and _DATE_RE.match(parts[3])):
        guild_name, guild_id = _split_dirname(parts[0])
        channel_name, channel_id = _split_dirname(parts[2])
        return DiscordScope(
            level="date",
            use_native=True,
            guild_name=guild_name,
            guild_id=guild_id,
            channel_name=channel_name,
            channel_id=channel_id,
            container="channels",
            date_str=parts[3],
            resource_path=key,
        )

    # /<guild>/channels/<ch>/<date>/chat.jsonl or .../files
    if (len(parts) == 5 and parts[1] == "channels"
            and _DATE_RE.match(parts[3])):
        guild_name, guild_id = _split_dirname(parts[0])
        channel_name, channel_id = _split_dirname(parts[2])
        if parts[4] == "chat.jsonl":
            return DiscordScope(
                level="messages",
                use_native=False,
                guild_name=guild_name,
                guild_id=guild_id,
                channel_name=channel_name,
                channel_id=channel_id,
                container="channels",
                date_str=parts[3],
                resource_path=key,
            )
        if parts[4] == "files":
            return DiscordScope(
                level="files",
                use_native=True,
                guild_name=guild_name,
                guild_id=guild_id,
                channel_name=channel_name,
                channel_id=channel_id,
                container="channels",
                date_str=parts[3],
                resource_path=key,
            )

    # /<guild>/channels/<ch>/<date>/files/<blob>
    if (len(parts) == 6 and parts[1] == "channels" and _DATE_RE.match(parts[3])
            and parts[4] == "files"):
        guild_name, guild_id = _split_dirname(parts[0])
        channel_name, channel_id = _split_dirname(parts[2])
        return DiscordScope(
            level="file_blob",
            use_native=False,
            guild_name=guild_name,
            guild_id=guild_id,
            channel_name=channel_name,
            channel_id=channel_id,
            container="channels",
            date_str=parts[3],
            resource_path=key,
        )

    return DiscordScope(level="guild", use_native=False, resource_path=key)


def coalesce_scopes(paths: list[PathSpec]) -> DiscordScope | None:
    """Fold same-channel chat.jsonl operands into one channel scope.

    Only message files coalesce: guild search answers questions about
    message content, so widening any other leaf (an attachment blob, a
    member JSON) to a channel-wide message search would return hits that
    say nothing about the requested bytes.
    """
    if not paths:
        return None
    scopes = [detect_scope(p) for p in paths]
    first = scopes[0]
    if (first.level != "messages" or first.guild_id is None
            or first.channel_id is None):
        return None
    for s in scopes[1:]:
        if (s.level != "messages" or s.guild_id != first.guild_id
                or s.channel_id != first.channel_id):
            return None
    return DiscordScope(
        level="channel",
        use_native=True,
        guild_name=first.guild_name,
        guild_id=first.guild_id,
        channel_name=first.channel_name,
        channel_id=first.channel_id,
        container="channels",
        resource_path=first.resource_path.rsplit("/", 1)[0],
    )
