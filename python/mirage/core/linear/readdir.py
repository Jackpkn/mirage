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

from collections.abc import Mapping
from typing import Any

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.linear.client import (list_issue_comments, list_team_cycles,
                                       list_team_documents, list_team_issues,
                                       list_team_members, list_team_projects,
                                       list_teams)
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import (normalize_comment, normalize_cycle,
                                          normalize_document, normalize_issue,
                                          normalize_project, normalize_team,
                                          normalize_user, project_issue_rows,
                                          to_json_bytes)
from mirage.core.linear.pathing import (cycle_filename, document_filename,
                                        issue_dirname, member_filename,
                                        project_filename, team_dirname)
from mirage.core.linear.scope import detect_scope
from mirage.core.render.json import jsonl_bytes_by_created_at

TEAM_DIRS = ("members", "issues", "projects", "cycles", "documents")


async def find_team(config: LinearConfig,
                    slots: Mapping[str, str]) -> dict[str, Any] | None:
    """The team the slots name, None when no listing carries it.

    Existence is proven against the team listing by the full
    ``label__id`` dirname, never by calling the API with the typed id: a
    bogus id must read as ENOENT, not as a Linear API error.

    Args:
        config (LinearConfig): mount configuration.
        slots (Mapping[str, str]): a match holding ``team`` and
            ``team_id``.
    """
    target = f"{slots['team']}__{slots['team_id']}"
    teams = await list_teams(config)
    if config.team_ids:
        teams = [team for team in teams if team.get("id") in config.team_ids]
    for team in teams:
        if team_dirname(team) == target:
            return team
    return None


async def find_issue(config: LinearConfig,
                     slots: Mapping[str, str]) -> dict[str, Any] | None:
    """The issue the slots name, validated through its team.

    Args:
        config (LinearConfig): mount configuration.
        slots (Mapping[str, str]): a match holding the team slots plus
            ``issue`` and ``issue_id``.
    """
    if await find_team(config, slots) is None:
        return None
    target = f"{slots['issue']}__{slots['issue_id']}"
    for issue in await list_team_issues(config, slots["team_id"]):
        if issue_dirname(issue) == target:
            return issue
    return None


async def _list_teams_dir(accessor: LinearAccessor,
                          match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    teams = await list_teams(accessor.config)
    if accessor.config.team_ids:
        teams = [
            team for team in teams
            if team.get("id") in accessor.config.team_ids
        ]
    entries = []
    for team in teams:
        dirname = team_dirname(team)
        entries.append((dirname,
                        IndexEntry(
                            id=team["id"],
                            name=team.get("name") or team.get("key")
                            or team["id"],
                            resource_type="linear/team",
                            remote_time=team.get("updatedAt") or "",
                            vfs_name=dirname,
                            extra={
                                "team_key":
                                team.get("key"),
                                "team_name":
                                team.get("name"),
                                "team_json_size":
                                len(to_json_bytes(normalize_team(team))),
                            },
                        )))
    return entries


async def _list_team(accessor: LinearAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    team = await find_team(accessor.config, match.slots)
    if team is None:
        return None
    # team.json renders the team object this find already fetched, so its
    # exact size is free here.
    entries = [("team.json",
                IndexEntry(
                    id=team["id"],
                    name="team.json",
                    resource_type="linear/team_json",
                    remote_time=team.get("updatedAt") or "",
                    vfs_name="team.json",
                    size=len(to_json_bytes(normalize_team(team))),
                ))]
    for name in TEAM_DIRS:
        entries.append((name,
                        IndexEntry(
                            id=team["id"],
                            name=name,
                            resource_type=f"linear/{name}_dir",
                            vfs_name=name,
                        )))
    return entries


async def _list_members(
        accessor: LinearAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_team(accessor.config, match.slots) is None:
        return None
    users = await list_team_members(accessor.config, match.slots["team_id"])
    entries = []
    for user in users:
        filename = member_filename(user)
        entries.append((filename,
                        IndexEntry(
                            id=user["id"],
                            name=user.get("name") or user.get("displayName")
                            or user["id"],
                            resource_type="linear/user",
                            remote_time=user.get("updatedAt") or "",
                            vfs_name=filename,
                            size=len(to_json_bytes(normalize_user(user))),
                        )))
    return entries


async def _list_issues(
        accessor: LinearAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_team(accessor.config, match.slots) is None:
        return None
    issues = await list_team_issues(accessor.config, match.slots["team_id"])
    entries = []
    for issue in issues:
        dirname = issue_dirname(issue)
        entries.append((dirname,
                        IndexEntry(
                            id=issue["id"],
                            name=issue.get("identifier") or issue["id"],
                            resource_type="linear/issue",
                            remote_time=issue.get("updatedAt") or "",
                            vfs_name=dirname,
                            extra={
                                "issue_key":
                                issue.get("identifier"),
                                "issue_json_size":
                                len(to_json_bytes(normalize_issue(issue))),
                            },
                        )))
    return entries


async def _list_issue(
        accessor: LinearAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    issue = await find_issue(accessor.config, match.slots)
    if issue is None:
        return None
    # issue.json renders the issue this find already fetched;
    # comments.jsonl costs the one bounded comments call, paid only when
    # this directory is entered.
    normalized = normalize_issue(issue)
    issue_id = issue["id"]
    remote_time = issue.get("updatedAt") or ""
    comments = await list_issue_comments(accessor.config, issue_id)
    rows = [
        normalize_comment(comment,
                          issue_id=issue_id,
                          issue_key=normalized.get("issue_key"))
        for comment in comments
    ]
    comments_time = max((row.get("updated_at") or "" for row in rows),
                        default="")
    return [
        ("issue.json",
         IndexEntry(
             id=issue_id,
             name="issue.json",
             resource_type="linear/issue_json",
             remote_time=remote_time,
             vfs_name="issue.json",
             size=len(to_json_bytes(normalized)),
         )),
        ("comments.jsonl",
         IndexEntry(
             id=issue_id,
             name="comments.jsonl",
             resource_type="linear/comments",
             remote_time=comments_time or remote_time,
             vfs_name="comments.jsonl",
             size=len(jsonl_bytes_by_created_at(rows)),
         )),
    ]


async def _list_projects(
        accessor: LinearAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    team = await find_team(accessor.config, match.slots)
    if team is None:
        return None
    team_id = match.slots["team_id"]
    projects = await list_team_projects(accessor.config, team_id)
    team_issues = await list_team_issues(accessor.config, team_id)
    entries = []
    for project in projects:
        rendered = normalize_project(
            project,
            team_id=team_id,
            team_key=team.get("key"),
            team_name=team.get("name"),
            issues=project_issue_rows(team_issues, project.get("id")),
        )
        filename = project_filename(project)
        entries.append((filename,
                        IndexEntry(
                            id=project["id"],
                            name=project.get("name") or project["id"],
                            resource_type="linear/project",
                            remote_time=project.get("updatedAt") or "",
                            vfs_name=filename,
                            size=len(to_json_bytes(rendered)),
                        )))
    return entries


async def _list_cycles(
        accessor: LinearAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_team(accessor.config, match.slots) is None:
        return None
    team_id = match.slots["team_id"]
    cycles = await list_team_cycles(accessor.config, team_id)
    entries = []
    for cycle in cycles:
        filename = cycle_filename(cycle)
        entries.append(
            (filename,
             IndexEntry(
                 id=cycle["id"],
                 name=cycle.get("name") or cycle["id"],
                 resource_type="linear/cycle",
                 remote_time=cycle.get("updatedAt") or "",
                 vfs_name=filename,
                 size=len(
                     to_json_bytes(normalize_cycle(cycle, team_id=team_id))),
             )))
    return entries


async def _list_documents(
        accessor: LinearAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_team(accessor.config, match.slots) is None:
        return None
    documents = await list_team_documents(accessor.config,
                                          match.slots["team_id"])
    entries = []
    for document in documents:
        filename = document_filename(document)
        entries.append(
            (filename,
             IndexEntry(
                 id=document["id"],
                 name=document.get("title") or document["id"],
                 resource_type="linear/document",
                 remote_time=document.get("updatedAt") or "",
                 vfs_name=filename,
                 size=len(to_json_bytes(normalize_document(document))),
             )))
    return entries


readdir = make_readdir(
    detect_scope,
    listers={
        "teams": _list_teams_dir,
        "team": _list_team,
        "members": _list_members,
        "issues": _list_issues,
        "issue": _list_issue,
        "projects": _list_projects,
        "cycles": _list_cycles,
        "documents": _list_documents,
    },
    static_root=("teams", ),
)
