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

from mirage.accessor.s3 import S3Accessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.core.s3._client import (_client_kwargs, _prefix, _strip_prefix,
                                    async_session)
from mirage.types import PathSpec


async def find(
    accessor: S3Accessor,
    path_spec: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
) -> list[str]:
    """Find objects under a prefix with filtering.

    Args:
        accessor (S3Accessor): S3 accessor.
        path_spec (PathSpec): Prefix path.
        name (str | None): Glob pattern to match entry name.
        type (str | None): "f" (file) or "d" (directory).
        min_size (int | None): Minimum object size.
        max_size (int | None): Maximum object size.
        maxdepth (int | None): Maximum directory depth.
        name_exclude (str | None): Glob pattern to exclude.
        or_names (list[str] | None): Alternative name patterns (OR logic).
        mtime_min (float | None): Accepted for signature parity but not
            applied: S3 prefixes carry no mtime, so filtering would drop
            every directory and diverge from the TS backend and the shared
            integ truth.
        mtime_max (float | None): See mtime_min.
        iname (str | None): Case-insensitive glob pattern for basename.
        path_pattern (str | None): Glob pattern to match full path.
        mindepth (int | None): Minimum depth to include.
    """
    start_name = start_basename(path_spec)
    path = path_spec.mount_path
    config = accessor.config
    pfx = _prefix(path, config)
    stripped = path.strip("/")
    base = "/" + stripped if stripped else "/"
    base_depth = 0 if base == "/" else base.count("/")
    results: list[str] = []
    seen_dirs: set[str] = set()
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    saw_descendant = False
    dir_marker_seen = False
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=config.bucket, Prefix=pfx):
            for obj in page.get("Contents") or []:
                key = obj["Key"]
                if key == pfx:
                    dir_marker_seen = True
                    continue
                saw_descendant = True
                is_dir = key.endswith("/")
                norm_key = key[:-1] if is_dir else key
                full_path = "/" + _strip_prefix(norm_key, config)
                size = obj.get("Size", 0)
                if is_dir:
                    if full_path in seen_dirs:
                        continue
                    seen_dirs.add(full_path)
                entries: list[tuple[str, str]] = [(full_path,
                                                   "d" if is_dir else "f")]
                # Implicit directories exist only as key prefixes; synthesize
                # the parent chain so find agrees with readdir on
                # externally-populated buckets.
                parent = full_path.rsplit("/", 1)[0] or "/"
                while parent != base and parent != "/":
                    if parent not in seen_dirs:
                        seen_dirs.add(parent)
                        entries.append((parent, "d"))
                    parent = parent.rsplit("/", 1)[0] or "/"
                for ep, kind in entries:
                    entry_name = ep.rsplit("/", 1)[-1]
                    depth = ep.count("/") - base_depth
                    if maxdepth is not None and depth > maxdepth:
                        continue
                    is_empty = (None if not empty else
                                (size == 0 if kind == "f" else False))
                    entry = FindEntry(key=ep,
                                      name=entry_name,
                                      kind=kind,
                                      depth=depth,
                                      is_empty=is_empty)
                    if not keep(entry, tree, mindepth):
                        continue
                    if min_size is not None or max_size is not None:
                        # Directories count as size 0 for -size (deliberate
                        # GNU divergence).
                        effective = 0 if kind == "d" else size
                        if min_size is not None and effective < min_size:
                            continue
                        if max_size is not None and effective > max_size:
                            continue
                    results.append(ep)
    if saw_descendant or dir_marker_seen:
        emit_start_path(results,
                        base,
                        start_name,
                        kind="d",
                        is_empty=(not saw_descendant) if empty else None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)
    # A file key and a synthesized directory can name the same path (`data/a`
    # alongside `data/a/b.txt`), which these stores allow and a filesystem
    # does not; find prints such a path once.
    return sorted(set(results))
