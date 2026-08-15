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
from typing import Any

from mirage.accessor.s3 import S3Accessor, S3Config
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.s3._client import (_client_kwargs, _key, _prefix,
                                    _strip_prefix, async_session, is_not_found)
from mirage.core.s3.constants import SCOPE_ERROR
from mirage.core.timeutil import to_iso_z
from mirage.types import PathSpec
from mirage.utils.errors import enotdir, readdir_error
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def _is_file(client: Any, config: S3Config, key: str) -> bool:
    try:
        await client.head_object(Bucket=config.bucket, Key=_key(key, config))
    except Exception as exc:
        if is_not_found(exc):
            return False
        raise
    return True


async def _is_dir(client: Any, config: S3Config, key: str) -> bool:
    resp = await client.list_objects_v2(Bucket=config.bucket,
                                        Prefix=_prefix(key, config),
                                        Delimiter="/",
                                        MaxKeys=1)
    return bool(resp.get("CommonPrefixes") or resp.get("Contents"))


async def _listing_error(client: Any, config: S3Config, path_spec: PathSpec,
                         path: str) -> OSError:
    """The errno for a path the bucket holds no key at or under.

    Args:
        client (Any): Open S3 client.
        config (S3Config): Bucket and key-prefix configuration.
        path_spec (PathSpec): The operand; ``virtual`` is the reported
            spelling.
        path (str): Mount-local path that was listed.
    """
    is_file = partial(_is_file, client, config)
    if await is_file(path):
        # An object, not a prefix: opendir(2) reports ENOTDIR, and the
        # ancestor walk cannot change that answer, because every ancestor
        # of a stored key is a prefix by construction.
        return enotdir(path_spec)
    return await readdir_error(path_spec, path, is_file,
                               partial(_is_dir, client, config))


async def readdir(accessor: S3Accessor,
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
    config = accessor.config
    raw_key = prefix + path if prefix else path
    virtual_key = raw_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    pfx = _prefix(path, config)
    names: list[str] = []
    dir_keys: set[str] = set()
    sizes: dict[str, int | None] = {}
    times: dict[str, str] = {}
    saw_key = False
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=config.bucket,
                                             Prefix=pfx,
                                             Delimiter="/"):
            if page.get("CommonPrefixes") or page.get("Contents"):
                saw_key = True
            for cp in page.get("CommonPrefixes") or []:
                child = cp["Prefix"].rstrip("/")
                if child:
                    key = "/" + _strip_prefix(child, config)
                    names.append(key)
                    dir_keys.add(key)
            for obj in page.get("Contents") or []:
                relative = obj["Key"][len(pfx):]
                if relative and "/" not in relative:
                    key = "/" + _strip_prefix(obj["Key"], config)
                    names.append(key)
                    sizes[key] = obj.get("Size")
                    last_mod = obj.get("LastModified")
                    times[key] = to_iso_z(last_mod) if last_mod else ""
        if not saw_key and path.strip("/"):
            # An empty directory is a zero-byte marker object keyed at the
            # prefix itself, so a prefix holding no key at all -- not even
            # that marker -- is a path the bucket does not have. Without
            # this, `ls /s3/never` rendered an empty directory and exited
            # 0 where every real filesystem reports ENOENT. The mount root
            # is exempt: it exists because it is mounted.
            raise await _listing_error(client, config, path_spec, path)
    names = sorted(names)
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "s3 readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    index_entries = []
    for e in names:
        name = e.rsplit("/", 1)[-1]
        if e in dir_keys:
            # S3 "folders" are synthetic common-prefixes with no object
            # of their own, so there is no LastModified or Size to record.
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
