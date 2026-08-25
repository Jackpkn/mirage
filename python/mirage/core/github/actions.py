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

from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from mirage.core.github.client import github_request
from mirage.core.github.config import GhConfig
from mirage.core.github.paginate import github_pages
from mirage.core.github.repo import RepoRef
from mirage.types import JsonValue


def _actions(ref: RepoRef, tail: str) -> str:
    return f"/repos/{ref.owner}/{ref.repo}/actions/{tail}"


async def list_runs(config: GhConfig,
                    ref: RepoRef,
                    params: dict[str, str],
                    limit: int,
                    workflow: str | None = None) -> list[dict[str, Any]]:
    tail = (f"workflows/{quote(workflow, safe='')}/runs"
            if workflow else "runs")
    return await github_pages(config,
                              _actions(ref, tail),
                              params=params,
                              limit=limit,
                              key="workflow_runs")


async def get_run(config: GhConfig, ref: RepoRef, run_id: int) -> JsonValue:
    return await github_request(config.token,
                                "GET",
                                _actions(ref, f"runs/{run_id}"),
                                base_url=config.base_url)


async def rerun(config: GhConfig,
                ref: RepoRef,
                run_id: int,
                suffix: str,
                body: JsonValue = None) -> JsonValue:
    if body is None:
        return await github_request(config.token,
                                    "POST",
                                    _actions(ref, f"runs/{run_id}/{suffix}"),
                                    base_url=config.base_url)
    return await github_request(config.token,
                                "POST",
                                _actions(ref, f"runs/{run_id}/{suffix}"),
                                body,
                                base_url=config.base_url)


async def rerun_job(config: GhConfig, ref: RepoRef, job_id: int,
                    debug: bool) -> JsonValue:
    return await github_request(config.token,
                                "POST",
                                _actions(ref, f"jobs/{job_id}/rerun"),
                                {"enable_debug_logging": debug},
                                base_url=config.base_url)


async def list_workflows(
    config: GhConfig,
    ref: RepoRef,
    limit: int,
    *,
    include: Callable[[dict[str, Any]], bool]
    | None = None
) -> list[dict[str, Any]]:
    return await github_pages(config,
                              _actions(ref, "workflows"),
                              limit=limit,
                              key="workflows",
                              include=include)


async def get_workflow(config: GhConfig, ref: RepoRef,
                       workflow: str) -> JsonValue:
    return await github_request(config.token,
                                "GET",
                                _actions(
                                    ref,
                                    f"workflows/{quote(workflow, safe='')}"),
                                base_url=config.base_url)


async def dispatch_workflow(config: GhConfig, ref: RepoRef, workflow: str,
                            body: dict[str, JsonValue]) -> JsonValue:
    return await github_request(
        config.token,
        "POST",
        _actions(ref, f"workflows/{quote(workflow, safe='')}/dispatches"),
        body,
        base_url=config.base_url)
