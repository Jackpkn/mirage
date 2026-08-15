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

from collections.abc import AsyncIterator

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import list_folder
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.types import PathSpec, WalkEntry
from mirage.utils.fingerprint import stat_fingerprint
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook


class DropboxWalk:
    """One recursive ``list_folder`` feeding the generic listing differ.

    Reads the account directly, never through mirage's caches, as the
    DeltaHook contract requires.

    Fingerprints on ``content_hash``, Dropbox's own content digest, so
    an upload of identical bytes is correctly reported as no change;
    ``rev`` is the fallback, and it moves on any write.

    Dropbox also offers a cursor: the same endpoint returns one, and
    ``list_folder/continue`` replays only what changed since. That is a
    faster pull, not a more correct one, and it cannot replace this
    walk, because the server may invalidate a cursor at any time and
    the only answer to that is a full listing. When the fast path is
    added it belongs behind ``pull``, with this walk as its reset path.
    """

    def __init__(self, accessor: DropboxAccessor) -> None:
        """Args:
            accessor (DropboxAccessor): Backend handle.
        """
        self._accessor = accessor

    async def __call__(self, root: PathSpec) -> AsyncIterator[WalkEntry]:
        """Yield every entry under ``root``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
        """
        accessor = self._accessor
        prefix = mount_prefix_of(root.virtual, root.resource_path)
        api_root = dropbox_path_of(accessor, root)
        try:
            found = await list_folder(accessor.token_manager,
                                      api_root,
                                      recursive=True)
        except DropboxApiError as exc:
            # list_folder 409s on a missing path and on a file operand;
            # either way there is nothing under this root to report.
            if exc.status == 409:
                return
            raise
        # Dropbox paths are case-insensitive: `path_display` carries the
        # server's casing while `root_path` carries the user's, so a
        # configured `/team` whose displayed path is `/Team` matched
        # nothing and every event landed outside the watch scope. The
        # comparison folds case; the slice keeps the server's casing for
        # everything below the root, and is safe because `path_lower` is
        # `path_display` lowercased, same length.
        base = accessor.root_path
        folded = base.lower()
        for entry in found:
            display = entry.get("path_display") or entry.get("path_lower")
            if not display:
                continue
            relative = display[len(base):] if base and display.lower(
            ).startswith(folded) else display
            relative = relative.strip("/")
            if not relative:
                continue
            virtual = (prefix.rstrip("/") + "/" + relative if prefix else "/" +
                       relative)
            if entry.get(".tag") == "folder":
                yield WalkEntry(virtual=virtual, is_dir=True, fingerprint=None)
                continue
            modified = entry.get("server_modified") or entry.get(
                "client_modified") or None
            size = entry.get("size")
            size = size if isinstance(size, int) else None
            version = entry.get("content_hash") or entry.get("rev")
            yield WalkEntry(virtual=virtual,
                            is_dir=False,
                            fingerprint=stat_fingerprint(
                                version, modified, size),
                            size=size,
                            modified=modified)


def build_delta_hook(accessor: DropboxAccessor) -> DeltaHook:
    """Build the Dropbox delta hook.

    Args:
        accessor (DropboxAccessor): Backend handle.
    """
    return ListingDeltaHook(DropboxWalk(accessor))
