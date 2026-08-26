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

from mirage.core.github.client import github_request
from mirage.core.github.config import GhConfig
from mirage.core.github.paginate import github_pages
from mirage.core.github.repo import RepoRef
from mirage.types import JsonValue

STATUS_CONCLUSIONS = ("error", "failure", "success")


def _path(ref: RepoRef, tail: str = "") -> str:
    return f"/repos/{ref.owner}/{ref.repo}/pulls{tail}"


async def list_pulls(
    config: GhConfig,
    ref: RepoRef,
    params: dict[str, str],
    limit: int,
    *,
    include: Callable[[dict[str, Any]], bool]
    | None = None
) -> list[dict[str, Any]]:
    return await github_pages(config,
                              _path(ref),
                              params=params,
                              limit=limit,
                              include=include)


async def get_pull(config: GhConfig, ref: RepoRef, number: int) -> JsonValue:
    return await github_request(config.token,
                                "GET",
                                _path(ref, f"/{number}"),
                                base_url=config.base_url)


async def create_pull(config: GhConfig, ref: RepoRef,
                      body: dict[str, JsonValue]) -> JsonValue:
    return await github_request(config.token,
                                "POST",
                                _path(ref),
                                body,
                                base_url=config.base_url)


async def edit_pull(config: GhConfig, ref: RepoRef, number: int,
                    body: dict[str, JsonValue]) -> JsonValue:
    return await github_request(config.token,
                                "PATCH",
                                _path(ref, f"/{number}"),
                                body,
                                base_url=config.base_url)


async def merge_pull(config: GhConfig, ref: RepoRef, number: int,
                     body: dict[str, JsonValue]) -> JsonValue:
    if not body:
        return await github_request(config.token,
                                    "PUT",
                                    _path(ref, f"/{number}/merge"),
                                    base_url=config.base_url)
    return await github_request(config.token,
                                "PUT",
                                _path(ref, f"/{number}/merge"),
                                body,
                                base_url=config.base_url)


async def comment_pull(config: GhConfig, ref: RepoRef, number: int,
                       body: str) -> JsonValue:
    await get_pull(config, ref, number)
    path = f"/repos/{ref.owner}/{ref.repo}/issues/{number}/comments"
    return await github_request(config.token,
                                "POST",
                                path, {"body": body},
                                base_url=config.base_url)


async def diff_pull(config: GhConfig, ref: RepoRef, number: int) -> str:
    value = await github_request(
        config.token,
        "GET",
        _path(ref, f"/{number}"),
        base_url=config.base_url,
        headers={"Accept": "application/vnd.github.v3.diff"})
    return value if isinstance(value, str) else ""


def _status_check(row: dict[str, Any]) -> dict[str, Any]:
    state = str(row.get("state") or "")
    done = state in STATUS_CONCLUSIONS
    return {
        "name": row.get("context") or "",
        "status": "completed" if done else state,
        "conclusion": state if done else None,
        "details_url": row.get("target_url") or "",
        "output": {
            "summary": row.get("description") or ""
        },
        "started_at": row.get("created_at"),
        "completed_at": row.get("updated_at"),
    }


async def commit_statuses(config: GhConfig, ref: RepoRef,
                          sha: str) -> list[dict[str, Any]]:
    value = await github_request(
        config.token,
        "GET",
        f"/repos/{ref.owner}/{ref.repo}/commits/{sha}/status",
        base_url=config.base_url)
    rows = value.get("statuses") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


async def pull_checks(config: GhConfig,
                      ref: RepoRef,
                      number: int,
                      limit: int = 100) -> list[dict[str, Any]]:
    pull = await get_pull(config, ref, number)
    head = pull.get("head") if isinstance(pull, dict) else None
    sha = head.get("sha") if isinstance(head, dict) else None
    if not isinstance(sha, str):
        return []
    path = f"/repos/{ref.owner}/{ref.repo}/commits/{sha}/check-runs"
    runs = await github_pages(config, path, limit=limit, key="check_runs")
    statuses = await commit_statuses(config, ref, sha)
    return runs + [_status_check(row) for row in statuses]
