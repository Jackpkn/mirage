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

from mirage.core.discord.scope import coalesce_scopes, detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _gs(path: str, prefix: str = "", pattern: str | None = None) -> PathSpec:
    return PathSpec(
        resource_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] + "/" if pattern else path,
        pattern=pattern,
        resolved=pattern is None,
    )


# ── root ──────────────────────────────────────


def test_root_empty():
    scope = detect_scope(PathSpec.from_str_path("/"))
    assert scope.level == "root"
    assert scope.use_native is True
    assert scope.resource_path == "/"


def test_root_prefix():
    scope = detect_scope(_gs("/discord/", prefix="/discord"))
    assert scope.level == "root"


# ── guild ─────────────────────────────────────


def test_guild():
    scope = detect_scope(_gs("/discord/myserver__G1", prefix="/discord"))
    assert scope.level == "guild"
    assert scope.use_native is True
    assert scope.guild_name == "myserver"
    assert scope.guild_id == "G1"


def test_guild_channels():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels", prefix="/discord"))
    assert scope.level == "guild"
    assert scope.use_native is True
    assert scope.container == "channels"
    assert scope.guild_id == "G1"


def test_guild_members_not_native():
    scope = detect_scope(
        _gs("/discord/myserver__G1/members", prefix="/discord"))
    assert scope.level == "guild"
    assert scope.use_native is False
    assert scope.container == "members"
    assert scope.guild_id == "G1"


def test_guild_bare_name_has_no_id():
    scope = detect_scope(_gs("/discord/myserver", prefix="/discord"))
    assert scope.level == "guild"
    assert scope.guild_name == "myserver"
    assert scope.guild_id is None


# ── channel ───────────────────────────────────


def test_channel():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general__C1", prefix="/discord"))
    assert scope.level == "channel"
    assert scope.use_native is True
    assert scope.guild_name == "myserver"
    assert scope.guild_id == "G1"
    assert scope.channel_name == "general"
    assert scope.channel_id == "C1"
    assert scope.container == "channels"


def test_channel_bare_name_has_no_id():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general", prefix="/discord"))
    assert scope.level == "channel"
    assert scope.channel_name == "general"
    assert scope.channel_id is None


# ── member ────────────────────────────────────


def test_member_json():
    scope = detect_scope(
        _gs("/discord/myserver__G1/members/alice__U1.json", prefix="/discord"))
    assert scope.level == "member"
    assert scope.use_native is False
    assert scope.container == "members"
    assert scope.guild_id == "G1"
    assert scope.member_name == "alice"
    assert scope.member_id == "U1"
    assert scope.channel_id is None


# ── date / messages / files ────────────────────


def test_date_dir():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general__C1/2026-04-10",
            prefix="/discord"))
    assert scope.level == "date"
    assert scope.use_native is True
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"
    assert scope.date_str == "2026-04-10"


def test_messages_file():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general__C1/2026-04-10/chat.jsonl",
            prefix="/discord"))
    assert scope.level == "messages"
    assert scope.use_native is False
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"
    assert scope.date_str == "2026-04-10"


def test_files_dir():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general__C1/2026-04-10/files",
            prefix="/discord"))
    assert scope.level == "files"
    assert scope.use_native is True
    assert scope.date_str == "2026-04-10"


def test_file_blob():
    scope = detect_scope(
        _gs(
            "/discord/myserver__G1/channels/general__C1/2026-04-10/files/"
            "img__A1.png",
            prefix="/discord"))
    assert scope.level == "file_blob"
    assert scope.use_native is False
    assert scope.channel_id == "C1"
    assert scope.date_str == "2026-04-10"


def test_deep_unknown_path_falls_back():
    scope = detect_scope(_gs("/discord/a/b/c/d/e/f/g", prefix="/discord"))
    assert scope.level == "guild"
    assert scope.use_native is False


# ── glob patterns ─────────────────────────────


def test_glob_jsonl_in_channel():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general__C1/*.jsonl",
            prefix="/discord",
            pattern="*.jsonl"))
    assert scope.level == "channel"
    assert scope.use_native is True
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"


def test_glob_jsonl_in_date_dir():
    scope = detect_scope(
        _gs("/discord/myserver__G1/channels/general__C1/2026-04-10/*.jsonl",
            prefix="/discord",
            pattern="*.jsonl"))
    assert scope.level == "messages"
    assert scope.use_native is True
    assert scope.date_str == "2026-04-10"
    assert scope.channel_id == "C1"


def test_glob_non_jsonl():
    scope = detect_scope(
        _gs("/discord/myserver__G1/members/*.json",
            prefix="/discord",
            pattern="*.json"))
    assert scope.level != "channel"


# ── coalesce ──────────────────────────────────


def _spec(path: str, prefix: str = "/discord") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path)


def test_coalesce_concrete_jsonl_paths_same_channel():
    paths = [
        _spec(f"/discord/myserver__G1/channels/general__C1/"
              f"2026-01-{d:02d}/chat.jsonl") for d in range(1, 8)
    ]
    scope = coalesce_scopes(paths)
    assert scope is not None
    assert scope.level == "channel"
    assert scope.use_native is True
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"


def test_coalesce_returns_none_for_mixed_channels():
    paths = [
        _spec("/discord/myserver__G1/channels/general__C1/"
              "2026-01-01/chat.jsonl"),
        _spec("/discord/myserver__G1/channels/random__C2/"
              "2026-01-01/chat.jsonl"),
    ]
    assert coalesce_scopes(paths) is None


def test_coalesce_returns_none_without_ids():
    paths = [
        _spec("/discord/myserver/channels/general/2026-01-01/chat.jsonl"),
    ]
    assert coalesce_scopes(paths) is None


def test_coalesce_empty_list_returns_none():
    assert coalesce_scopes([]) is None


def test_coalesce_returns_none_for_file_blobs():
    # Guild search answers questions about message content; an attachment
    # operand must scan its bytes, not widen to a channel message search.
    paths = [
        _spec("/discord/myserver__G1/channels/general__C1/2026-01-01/files/"
              "img__A1.png"),
    ]
    assert coalesce_scopes(paths) is None


def test_coalesce_returns_none_for_mixed_levels():
    paths = [
        _spec("/discord/myserver__G1/channels/general__C1/"
              "2026-01-01/chat.jsonl"),
        _spec("/discord/myserver__G1/channels/general__C1/2026-01-01/files/"
              "img__A1.png"),
    ]
    assert coalesce_scopes(paths) is None
