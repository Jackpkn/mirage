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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import RouteMatch
from mirage.core.langfuse.client import (fetch_dataset_items,
                                         fetch_dataset_runs, fetch_or_enoent,
                                         fetch_prompt, fetch_trace)
from mirage.core.langfuse.scope import detect_scope
from mirage.core.render.json import json_bytes, jsonl_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _read_trace(accessor: LangfuseAccessor, match: RouteMatch,
                      path: PathSpec, index: IndexCacheStore) -> bytes:
    data = await fetch_or_enoent(
        fetch_trace(accessor.api, match.captures["trace_id"]), path.virtual)
    return json_bytes(data)


async def _read_prompt_version(accessor: LangfuseAccessor, match: RouteMatch,
                               path: PathSpec,
                               index: IndexCacheStore) -> bytes:
    # The route's codec only matches plain ASCII integers, so the int()
    # here cannot raise.
    data = await fetch_or_enoent(
        fetch_prompt(accessor.api, match.captures["prompt_name"],
                     int(match.captures["version"])), path.virtual)
    return json_bytes(data)


async def _read_dataset_items(accessor: LangfuseAccessor, match: RouteMatch,
                              path: PathSpec,
                              index: IndexCacheStore) -> bytes:
    items = await fetch_or_enoent(
        fetch_dataset_items(accessor.api, match.captures["dataset_name"]),
        path.virtual)
    return jsonl_bytes(items)


async def _read_dataset_run(accessor: LangfuseAccessor, match: RouteMatch,
                            path: PathSpec, index: IndexCacheStore) -> bytes:
    runs = await fetch_or_enoent(
        fetch_dataset_runs(accessor.api, match.captures["dataset_name"]),
        path.virtual)
    run_name = match.captures["run_name"]
    matched = [r for r in runs if r.get("name") == run_name]
    if not matched:
        raise enoent(path.virtual)
    # A .jsonl path must render as line-delimited JSON, not an indented
    # document: readers that split on newlines (jq) otherwise choke on
    # the first bare brace.
    return jsonl_bytes(matched[:1])


read = make_read(
    detect_scope, {
        "trace": _read_trace,
        "session_trace": _read_trace,
        "prompt_version": _read_prompt_version,
        "dataset_items": _read_dataset_items,
        "dataset_run": _read_dataset_run,
    })
