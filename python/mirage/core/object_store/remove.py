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

from mirage.cache.context import invalidate_after_unlink, invalidate_ancestors
from mirage.core.object_store.driver import (A, C, ObjectStoreDriver, PathFn)
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp


def make_unlink(driver: ObjectStoreDriver[A, C]) -> PathFn[A]:
    """Build single-key deletion over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def unlink(accessor: A, path_spec: PathSpec) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        async with driver.connect(accessor) as conn:
            await driver.delete_file(conn, key)
        await invalidate_after_unlink(path_spec)
        # Deleting the last key under a prefix makes every ancestor that
        # existed only as that prefix disappear, so their cached listings
        # are stale symmetrically to the write case.
        await invalidate_ancestors(path_spec)

    return unlink


def make_remove_prefix(driver: ObjectStoreDriver[A, C]) -> PathFn[A]:
    """Build recursive prefix deletion over one driver.

    Serves both the ``rm_r`` and ``rmdir`` slots: on a keyed store an
    empty directory is its marker object, so removing it and removing a
    subtree are the same prefix delete.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def remove_prefix(accessor: A, path_spec: PathSpec) -> None:
        path = path_spec.mount_path
        pfx = kp.apply_dir(driver.key_prefix_of(accessor), path)
        async with driver.connect(accessor) as conn:
            await driver.delete_prefix(conn, pfx)
        await invalidate_after_unlink(path_spec)
        # Same rationale as unlink: ancestors that existed only as this
        # prefix are gone now.
        await invalidate_ancestors(path_spec)

    return remove_prefix
