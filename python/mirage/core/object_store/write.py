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

import time

from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.object_store.driver import (A, C, MkdirFn, ObjectStoreDriver,
                                             PathFn, TruncateFn, WriteFn)
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp


def make_write_bytes(driver: ObjectStoreDriver[A, C]) -> WriteFn[A]:
    """Build the whole-object write over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def write_bytes(accessor: A, path_spec: PathSpec,
                          data: bytes) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        start_ms = int(time.monotonic() * 1000)
        async with driver.connect(accessor) as conn:
            await driver.put(conn, key, data)
        record("write", path, driver.resource, len(data), start_ms)
        await invalidate_after_write(path_spec)
        # A put materializes every missing level of the key at once, so
        # the listings above the immediate parent gained entries too.
        await invalidate_ancestors(path_spec)

    return write_bytes


def make_create(driver: ObjectStoreDriver[A, C]) -> PathFn[A]:
    """Build the empty-object create over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def create(accessor: A, path_spec: PathSpec) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        start_ms = int(time.monotonic() * 1000)
        async with driver.connect(accessor) as conn:
            await driver.put(conn, key, b"")
        record("create", path, driver.resource, 0, start_ms)
        await invalidate_after_write(path_spec)
        # An empty put materializes missing parents exactly like write.
        await invalidate_ancestors(path_spec)

    return create


def make_truncate(driver: ObjectStoreDriver[A, C]) -> TruncateFn[A]:
    """Build read-slice-pad-rewrite truncation over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def truncate(accessor: A, path_spec: PathSpec,
                       length: int) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        start_ms = int(time.monotonic() * 1000)
        async with driver.connect(accessor) as conn:
            data = await driver.get(conn, key)
            if data is None:
                data = b""
            result = data[:length].ljust(length, b"\0")
            await driver.put(conn, key, result)
        record("truncate", path, driver.resource, 0, start_ms)
        await invalidate_after_write(path_spec)
        # Truncating a missing key creates it, parents included.
        await invalidate_ancestors(path_spec)

    return truncate


def make_mkdir(driver: ObjectStoreDriver[A, C]) -> MkdirFn[A]:
    """Build the marker-object mkdir over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def mkdir(accessor: A,
                    path_spec: PathSpec,
                    parents: bool = False) -> None:
        # Object stores have no real directories; parents is implicit. A
        # zero-byte marker keyed at the prefix makes the empty directory
        # visible.
        path = path_spec.mount_path
        pfx = kp.apply_dir(driver.key_prefix_of(accessor), path)
        if pfx:
            async with driver.connect(accessor) as conn:
                await driver.put(conn, pfx, b"")
            await invalidate_after_write(path_spec)
            if parents:
                await invalidate_ancestors(path_spec)

    return mkdir
