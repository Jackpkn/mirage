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

import logging
from functools import partial

from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.object_store.driver import A, C, ObjectStoreDriver, ReaddirFn
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import listing_error
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def _probe_file(driver: ObjectStoreDriver[A, C], conn: C, kpfx: str,
                      key: str) -> bool:
    return await driver.head(conn, kp.apply(kpfx, key)) is not None


async def _probe_dir(driver: ObjectStoreDriver[A, C], conn: C, kpfx: str,
                     key: str) -> bool:
    return await driver.probe_prefix(conn, kp.apply_dir(kpfx, key))


def make_readdir(driver: ObjectStoreDriver[A, C]) -> ReaddirFn[A]:
    """Build a prefix listing with index write-back over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def readdir(accessor: A,
                      path_spec: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> list[str]:
        prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
        # When called from resolve_glob with a pattern (e.g. *.txt),
        # use path.directory for the listing. Direct callers (ls, ops)
        # pass pattern=None so path.virtual is used.
        path = path_spec.directory if path_spec.pattern else path_spec.virtual
        if prefix and path.startswith(prefix):
            rest = path[len(prefix):]
            if prefix.endswith("/") or rest == "" or rest.startswith("/"):
                path = rest or "/"
        kpfx = driver.key_prefix_of(accessor)
        raw_key = prefix + path if prefix else path
        virtual_key = raw_key.rstrip("/") or "/"
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
        pfx = kp.apply_dir(kpfx, path)
        names: list[str] = []
        dir_keys: set[str] = set()
        sizes: dict[str, int | None] = {}
        times: dict[str, str] = {}
        saw_key = False
        async with driver.connect(accessor) as conn:
            async for child in driver.list_children(conn, pfx):
                saw_key = True
                if child.kind == "marker":
                    continue
                key = "/" + kp.strip(kpfx, child.key)
                if child.kind == "d":
                    if key in dir_keys:
                        continue
                    names.append(key)
                    dir_keys.add(key)
                else:
                    names.append(key)
                    sizes[key] = child.size
                    times[key] = child.modified
            if not saw_key and path.strip("/"):
                # An empty directory is a zero-byte marker object keyed at
                # the prefix itself, so a prefix holding no key at all --
                # not even that marker -- is a path the store does not
                # have. Without this, `ls` on a missing path rendered an
                # empty directory and exited 0 where every real filesystem
                # reports ENOENT. The mount root is exempt: it exists
                # because it is mounted.
                raise await listing_error(
                    path_spec, path, partial(_probe_file, driver, conn, kpfx),
                    partial(_probe_dir, driver, conn, kpfx))
        names = sorted(names)
        if len(names) > driver.scope_error:
            logger.warning(
                "%s readdir: %s returned %d entries (limit %d)",
                driver.resource,
                virtual_key,
                len(names),
                driver.scope_error,
            )
        virtual_entries = sorted((prefix + e if prefix else e) for e in names)
        index_entries = []
        for e in names:
            name = e.rsplit("/", 1)[-1]
            if e in dir_keys:
                # Store "folders" are synthetic prefixes with no object of
                # their own, so there is no mtime or size to record.
                entry = IndexEntry(id=e,
                                   name=name,
                                   resource_type=ResourceType.FOLDER)
            else:
                entry = IndexEntry(id=e,
                                   name=name,
                                   resource_type=ResourceType.FILE,
                                   size=sizes.get(e),
                                   remote_time=times.get(e, ""))
            index_entries.append((name, entry))
        await index.set_dir(virtual_key, index_entries)
        return virtual_entries

    return readdir
