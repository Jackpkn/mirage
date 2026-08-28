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

from dataclasses import dataclass

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                LookupStatus)
from mirage.core.hf_hub.tree import ensure_live_index, local_rows, refill_index


@dataclass(frozen=True, slots=True)
class Found:
    """What sits at one mount-absolute key.

    ``entry`` is None for a directory the tree implies but has no row of
    its own for, which is why a caller must read ``is_dir`` and
    ``exists`` rather than testing ``entry`` for truth.

    Args:
        entry (IndexEntry | None): the tree row, when there is one.
        children (list[str] | None): the directory's listing, when the
            key names a directory.
    """

    entry: IndexEntry | None = None
    children: list[str] | None = None

    @property
    def exists(self) -> bool:
        return self.entry is not None or self.children is not None

    @property
    def is_dir(self) -> bool:
        if self.children is not None:
            return True
        return self.entry is not None and self.entry.resource_type == "folder"


async def lookup(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
) -> Found:
    """Resolve one mount-absolute key against the mount's listing.

    The single place the two storage paths are told apart: a workspace
    mount answers from its seeded index, and a mount built without one
    (a unit test, a command constructed outside a workspace) answers from
    tables derived from the accessor's tree. Both are built by
    ``index_rows``, so they cannot disagree.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.

    Returns:
        Found: the row and/or listing at that key.
    """
    if index is NULL_INDEX:
        entries, children = await local_rows(accessor, prefix)
        return Found(entry=entries.get(key), children=children.get(key))
    await ensure_live_index(accessor, index, prefix)
    result = await index.get(key)
    listing = await index.list_dir(key)
    # The index is the whole listing rather than a cache in front of one,
    # so an *expired* answer means the tree aged out, not that the path
    # is gone. Refetch once and ask again; a miss against a live index is
    # a real absence and must not cost a tree fetch.
    if LookupStatus.EXPIRED in (result.status, listing.status):
        if await refill_index(accessor, index, prefix):
            result = await index.get(key)
            listing = await index.list_dir(key)
    return Found(entry=result.entry, children=listing.entries)


def key_of(prefix: str, local: str) -> str:
    """The mount-absolute key for a mount-local path.

    Args:
        prefix (str): the mount prefix ("/m"), or "" for a root mount.
        local (str): the path as the mount sees it.

    Returns:
        str: the key the index and the derived tables are keyed by.
    """
    rel = local.strip("/")
    stem = prefix.rstrip("/")
    if not rel:
        return stem or "/"
    return f"{stem}/{rel}" if stem else f"/{rel}"


async def probe_file(accessor: HfHubAccessor, index: IndexCacheStore,
                     prefix: str, local: str) -> bool:
    """Whether a mount-local path exists as a non-directory."""
    found = await lookup(accessor, index, prefix, key_of(prefix, local))
    return found.exists and not found.is_dir


async def probe_dir(accessor: HfHubAccessor, index: IndexCacheStore,
                    prefix: str, local: str) -> bool:
    """Whether a mount-local path exists as a directory."""
    found = await lookup(accessor, index, prefix, key_of(prefix, local))
    return found.is_dir


def dir_stat_entry(key: str) -> IndexEntry:
    """A row for a directory the tree implies but has no row for.

    Args:
        key (str): the mount-absolute path of the directory.

    Returns:
        IndexEntry: a folder row named after the key's last segment.
    """
    return IndexEntry(id="",
                      name=key.rstrip("/").rsplit("/", 1)[-1] or "/",
                      resource_type="folder")
