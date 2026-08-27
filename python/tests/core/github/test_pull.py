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

import pytest

from mirage.core.github.config import GhConfig
from mirage.core.github.pull import (comment_pull, commit_statuses, list_pulls,
                                     pull_checks)
from mirage.core.github.repo import RepoRef


@pytest.mark.asyncio
async def test_pull_checks_follow_the_head_sha(monkeypatch):

    async def get_pull(config, ref, number):
        return {"head": {"sha": "abc"}}

    async def pages(config, path, *, limit, key):
        assert (path, limit, key) == ("/repos/o/r/commits/abc/check-runs", 100,
                                      "check_runs")
        return [{"name": "test"}]

    async def statuses(config, ref, sha):
        assert sha == "abc"
        return []

    monkeypatch.setitem(pull_checks.__globals__, "get_pull", get_pull)
    monkeypatch.setitem(pull_checks.__globals__, "github_pages", pages)
    monkeypatch.setitem(pull_checks.__globals__, "commit_statuses", statuses)

    assert await pull_checks(GhConfig(token="t"), RepoRef("o", "r"), 3) == [{
        "name":
        "test"
    }]


@pytest.mark.asyncio
async def test_pull_checks_merge_commit_status_contexts(monkeypatch):

    async def get_pull(config, ref, number):
        return {"head": {"sha": "abc"}}

    async def pages(config, path, *, limit, key):
        return []

    async def statuses(config, ref, sha):
        return [{
            "context": "ci/legacy",
            "state": "failure",
            "target_url": "https://ci.test/1",
            "description": "boom",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:01:00Z",
        }, {
            "context": "ci/slow",
            "state": "pending",
        }]

    monkeypatch.setitem(pull_checks.__globals__, "get_pull", get_pull)
    monkeypatch.setitem(pull_checks.__globals__, "github_pages", pages)
    monkeypatch.setitem(pull_checks.__globals__, "commit_statuses", statuses)

    rows = await pull_checks(GhConfig(token="t"), RepoRef("o", "r"), 3)

    assert rows == [{
        "name": "ci/legacy",
        "status": "completed",
        "conclusion": "failure",
        "details_url": "https://ci.test/1",
        "output": {
            "summary": "boom"
        },
        "started_at": "2026-01-01T00:00:00Z",
        "completed_at": "2026-01-01T00:01:00Z",
    }, {
        "name": "ci/slow",
        "status": "pending",
        "conclusion": None,
        "details_url": "",
        "output": {
            "summary": ""
        },
        "started_at": None,
        "completed_at": None,
    }]


@pytest.mark.asyncio
async def test_commit_statuses_read_the_combined_endpoint(monkeypatch):
    calls = []

    async def request(token, method, path, *args, **kwargs):
        calls.append((method, path))
        return {"state": "success", "statuses": [{"context": "ci"}, "junk"]}

    monkeypatch.setitem(commit_statuses.__globals__, "github_request", request)

    rows = await commit_statuses(GhConfig(token="t"), RepoRef("o", "r"), "abc")

    assert calls == [("GET", "/repos/o/r/commits/abc/status")]
    assert rows == [{"context": "ci"}]


@pytest.mark.asyncio
async def test_comment_pull_preflights_the_pull_number(monkeypatch):
    calls = []

    async def get(config, ref, number):
        calls.append(("GET", number))
        raise ValueError("not a pull request")

    async def request(*args, **kwargs):
        calls.append(("POST", 4))

    monkeypatch.setitem(comment_pull.__globals__, "get_pull", get)
    monkeypatch.setitem(comment_pull.__globals__, "github_request", request)

    with pytest.raises(ValueError, match="not a pull request"):
        await comment_pull(GhConfig(token="t"), RepoRef("o", "r"), 4, "no")
    assert calls == [("GET", 4)]


@pytest.mark.asyncio
async def test_list_pulls_filters_before_applying_the_limit(monkeypatch):
    seen = []

    async def pages(config, path, *, params, limit, include):
        seen.append((path, params, limit))
        rows = [{
            "number": 2,
            "merged_at": None
        }, {
            "number": 1,
            "merged_at": "now"
        }]
        return [row for row in rows if include(row)][:limit]

    monkeypatch.setitem(list_pulls.__globals__, "github_pages", pages)

    rows = await list_pulls(GhConfig(token="t"),
                            RepoRef("o", "r"), {"state": "closed"},
                            1,
                            include=lambda row: row["merged_at"] is not None)

    assert rows == [{"number": 1, "merged_at": "now"}]
    assert seen == [("/repos/o/r/pulls", {"state": "closed"}, 1)]
