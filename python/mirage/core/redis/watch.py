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

from collections.abc import Sequence

from mirage.accessor.redis import RedisAccessor
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.watch.base import EventHook
from mirage.watch.events import event_at

FILE_SEGMENT = "file:"

_REDIS_KINDS = {
    "set": FileChangeKind.UPDATE,
    "setrange": FileChangeKind.UPDATE,
    "append": FileChangeKind.UPDATE,
    "incrby": FileChangeKind.UPDATE,
    "copy_to": FileChangeKind.UPDATE,
    "restore": FileChangeKind.UPDATE,
    "rename_to": FileChangeKind.UPDATE,
    "del": FileChangeKind.DELETE,
    "unlink": FileChangeKind.DELETE,
    "expired": FileChangeKind.DELETE,
    "evicted": FileChangeKind.DELETE,
    "rename_from": FileChangeKind.DELETE,
}


class RedisEventHook:
    """Map one redis keyspace notification onto mount paths.

    The consumer subscribes to ``__keyevent@<db>__:*`` (which requires
    ``notify-keyspace-events`` to be configured; it is empty by default)
    and forwards the event verb with the key the message carried.

    Two limits are the protocol's, not this hook's, and both are
    reported honestly rather than guessed around:

    A ``set`` on a key that did not exist and one that did produce the
    same notification, so a create is reported as an UPDATE. Nothing is
    lost for a reader, because the watcher evicts the parent listing for
    either, but a consumer that needs the distinction has to pull.

    A rename arrives as two independent messages (``rename_from`` with
    the old key, ``rename_to`` with the new), so reconstructing a MOVE
    would need state this hook does not keep. They map to a DELETE and
    an UPDATE, which is what a poll-diff source reports for a rename
    too.

    Keys outside the mount's ``file:`` segment (the ``modified:`` and
    ``attrs:`` side keys, the ``dir`` set) name no file and map to
    nothing.
    """

    def __init__(self, accessor: RedisAccessor) -> None:
        """Args:
            accessor (RedisAccessor): Backend handle, read for its store.
        """
        self._accessor = accessor

    def _relative(self, key: str) -> str | None:
        """Mount-relative path for a redis key, or None if not a file.

        Args:
            key (str): The full key the notification carried.
        """
        head = f"{self._accessor.store.key_prefix}{FILE_SEGMENT}"
        if not key.startswith(head):
            return None
        return key[len(head):]

    async def to_events(self, root: PathSpec, event_type: str,
                        payload: JsonValue) -> Sequence[FileEvent]:
        """Map one keyspace notification to the change it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The redis event verb (``set``, ``del``, ...).
            payload (JsonValue): The key the message carried.
        """
        if not isinstance(payload, str):
            return ()
        relative = self._relative(payload)
        if relative is None:
            return ()
        kind = _REDIS_KINDS.get(event_type)
        if kind is None:
            return ()
        return (event_at(root, relative, kind), )


def build_event_hook(accessor: RedisAccessor) -> EventHook:
    """Build the redis event hook.

    Args:
        accessor (RedisAccessor): Backend handle.
    """
    return RedisEventHook(accessor)
