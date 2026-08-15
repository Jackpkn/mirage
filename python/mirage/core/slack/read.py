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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.slack import files as slack_files
from mirage.core.slack.history import get_history_jsonl
from mirage.core.slack.users import get_user_profile, user_json_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.ranges import range_header, slice_window


async def read(
    accessor: SlackAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a Slack path, optionally only a byte range of it.

    Only an uploaded file has a remote range to ask for. A channel's
    history and a user profile are rendered here into JSON, so their
    bytes do not exist until we make them and the window can only be
    taken afterwards.

    Args:
        accessor (SlackAccessor): Slack accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the entry.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path) if isinstance(
        path, PathSpec) else ""
    raw = path.virtual if isinstance(path, PathSpec) else path
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    key = raw.strip("/")
    parts = key.split("/")

    if (len(parts) == 4 and parts[0] in ("channels", "dms")
            and parts[3] == "chat.jsonl"):
        parent_key = f"{parts[0]}/{parts[1]}"
        virtual_key = prefix + "/" + parent_key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise enoent(virtual)
        channel_id = lookup.entry.id
        date_str = parts[2]
        history = await get_history_jsonl(accessor.config, channel_id,
                                          date_str)
        return slice_window(history, offset, size)

    if (len(parts) == 5 and parts[0] in ("channels", "dms")
            and parts[3] == "files"):
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None or not lookup.entry.extra:
            raise enoent(virtual)
        url = lookup.entry.extra.get("url_private_download")
        if not url:
            raise enoent(virtual)
        return await slack_files.download_file(accessor.config, url,
                                               range_header(offset, size))

    if len(parts) == 2 and parts[0] == "users":
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise enoent(virtual)
        user = await get_user_profile(accessor.config, lookup.entry.id)
        return slice_window(user_json_bytes(user), offset, size)

    raise enoent(virtual)
