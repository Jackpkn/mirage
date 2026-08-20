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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.trello.client import (list_board_labels, list_board_lists,
                                       list_board_members, list_list_cards,
                                       list_workspace_boards, list_workspaces)
from mirage.core.trello.normalize import (normalize_board, normalize_card,
                                          normalize_label, normalize_list,
                                          normalize_member,
                                          normalize_workspace, to_json_bytes)
from mirage.core.trello.pathing import (board_dirname, card_dirname,
                                        label_filename, list_dirname,
                                        member_filename, workspace_dirname)
from mirage.core.trello.scope import detect_scope
from mirage.resource.trello.config import TrelloConfig


async def find_workspace(config: TrelloConfig,
                         slots: Mapping[str, str]) -> dict[str, Any] | None:
    """The workspace the slots name, None when no listing carries it.

    Existence is proven against the workspace listing by the full
    ``label__id`` dirname, never by calling the API with the typed id: a
    bogus id must read as ENOENT, not as a Trello HTTP error.

    Args:
        config (TrelloConfig): mount configuration.
        slots (Mapping[str, str]): a match holding ``workspace`` and
            ``workspace_id``.
    """
    target = f"{slots['workspace']}__{slots['workspace_id']}"
    workspaces = await list_workspaces(config)
    if config.workspace_id:
        workspaces = [
            w for w in workspaces if w.get("id") == config.workspace_id
        ]
    for workspace in workspaces:
        if workspace_dirname(workspace) == target:
            return workspace
    return None


async def find_board(config: TrelloConfig,
                     slots: Mapping[str, str]) -> dict[str, Any] | None:
    """The board the slots name, validated through its workspace.

    Args:
        config (TrelloConfig): mount configuration.
        slots (Mapping[str, str]): a match holding the workspace slots
            plus ``board`` and ``board_id``.
    """
    if await find_workspace(config, slots) is None:
        return None
    target = f"{slots['board']}__{slots['board_id']}"
    boards = await list_workspace_boards(config, slots["workspace_id"])
    if config.board_ids:
        boards = [b for b in boards if b.get("id") in config.board_ids]
    for board in boards:
        if board_dirname(board) == target:
            return board
    return None


async def find_list(config: TrelloConfig,
                    slots: Mapping[str, str]) -> dict[str, Any] | None:
    """The list the slots name, validated through its board.

    Args:
        config (TrelloConfig): mount configuration.
        slots (Mapping[str, str]): a match holding the board slots plus
            ``list`` and ``list_id``.
    """
    if await find_board(config, slots) is None:
        return None
    target = f"{slots['list']}__{slots['list_id']}"
    for lst in await list_board_lists(config, slots["board_id"]):
        if list_dirname(lst) == target:
            return lst
    return None


async def find_card(config: TrelloConfig,
                    slots: Mapping[str, str]) -> dict[str, Any] | None:
    """The card the slots name, validated through its list.

    Args:
        config (TrelloConfig): mount configuration.
        slots (Mapping[str, str]): a match holding the list slots plus
            ``card`` and ``card_id``.
    """
    if await find_list(config, slots) is None:
        return None
    target = f"{slots['card']}__{slots['card_id']}"
    for card in await list_list_cards(config, slots["list_id"]):
        if card_dirname(card) == target:
            return card
    return None


async def _list_workspaces_dir(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    workspaces = await list_workspaces(accessor.config)
    if accessor.config.workspace_id:
        workspaces = [
            w for w in workspaces
            if w.get("id") == accessor.config.workspace_id
        ]
    entries = []
    for workspace in workspaces:
        dirname = workspace_dirname(workspace)
        entries.append((dirname,
                        IndexEntry(
                            id=workspace["id"],
                            name=workspace.get("displayName")
                            or workspace.get("name") or workspace["id"],
                            resource_type="trello/workspace",
                            remote_time="",
                            vfs_name=dirname,
                        )))
    return entries


async def _list_workspace(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    workspace = await find_workspace(accessor.config, match.slots)
    if workspace is None:
        return None
    # workspace.json renders the workspace object this find already
    # fetched, so its exact size is free here.
    return [
        ("workspace.json",
         IndexEntry(
             id=workspace["id"],
             name="workspace.json",
             resource_type="trello/workspace_json",
             vfs_name="workspace.json",
             size=len(to_json_bytes(normalize_workspace(workspace))),
         )),
        ("boards",
         IndexEntry(
             id=workspace["id"],
             name="boards",
             resource_type="trello/boards_dir",
             vfs_name="boards",
         )),
    ]


async def _list_boards(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_workspace(accessor.config, match.slots) is None:
        return None
    boards = await list_workspace_boards(accessor.config,
                                         match.slots["workspace_id"])
    if accessor.config.board_ids:
        boards = [
            b for b in boards if b.get("id") in accessor.config.board_ids
        ]
    entries = []
    for board in boards:
        dirname = board_dirname(board)
        entries.append((dirname,
                        IndexEntry(
                            id=board["id"],
                            name=board.get("name") or board["id"],
                            resource_type="trello/board",
                            remote_time=board.get("dateLastActivity") or "",
                            vfs_name=dirname,
                        )))
    return entries


async def _list_board(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    board = await find_board(accessor.config, match.slots)
    if board is None:
        return None
    # board.json's normalizer only uses fields the board listing already
    # carries, so its exact size is free here.
    remote_time = board.get("dateLastActivity") or ""
    return [
        ("board.json",
         IndexEntry(
             id=board["id"],
             name="board.json",
             resource_type="trello/board_json",
             vfs_name="board.json",
             size=len(to_json_bytes(normalize_board(board))),
             remote_time=remote_time,
         )),
        ("members",
         IndexEntry(id=board["id"],
                    name="members",
                    resource_type="trello/members_dir",
                    vfs_name="members")),
        ("labels",
         IndexEntry(id=board["id"],
                    name="labels",
                    resource_type="trello/labels_dir",
                    vfs_name="labels")),
        ("lists",
         IndexEntry(id=board["id"],
                    name="lists",
                    resource_type="trello/lists_dir",
                    vfs_name="lists")),
    ]


async def _list_members(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_board(accessor.config, match.slots) is None:
        return None
    members = await list_board_members(accessor.config,
                                       match.slots["board_id"])
    entries = []
    for member in members:
        filename = member_filename(member)
        entries.append((filename,
                        IndexEntry(
                            id=member["id"],
                            name=member.get("fullName")
                            or member.get("username") or member["id"],
                            resource_type="trello/member",
                            remote_time="",
                            vfs_name=filename,
                            size=len(to_json_bytes(normalize_member(member))),
                        )))
    return entries


async def _list_labels(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_board(accessor.config, match.slots) is None:
        return None
    labels = await list_board_labels(accessor.config, match.slots["board_id"])
    entries = []
    for label in labels:
        filename = label_filename(label)
        entries.append((filename,
                        IndexEntry(
                            id=label["id"],
                            name=label.get("name") or label.get("color")
                            or label["id"],
                            resource_type="trello/label",
                            remote_time="",
                            vfs_name=filename,
                            size=len(to_json_bytes(normalize_label(label))),
                        )))
    return entries


async def _list_lists(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_board(accessor.config, match.slots) is None:
        return None
    lists = await list_board_lists(accessor.config, match.slots["board_id"])
    entries = []
    for lst in lists:
        dirname = list_dirname(lst)
        entries.append((dirname,
                        IndexEntry(
                            id=lst["id"],
                            name=lst.get("name") or lst["id"],
                            resource_type="trello/list",
                            remote_time="",
                            vfs_name=dirname,
                        )))
    return entries


async def _list_list(accessor: TrelloAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    lst = await find_list(accessor.config, match.slots)
    if lst is None:
        return None
    # list.json's normalizer only uses fields the list listing already
    # carries, so its exact size is free here.
    return [
        ("list.json",
         IndexEntry(
             id=lst["id"],
             name="list.json",
             resource_type="trello/list_json",
             vfs_name="list.json",
             size=len(to_json_bytes(normalize_list(lst))),
         )),
        ("cards",
         IndexEntry(id=lst["id"],
                    name="cards",
                    resource_type="trello/cards_dir",
                    vfs_name="cards")),
    ]


async def _list_cards(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    if await find_list(accessor.config, match.slots) is None:
        return None
    cards = await list_list_cards(accessor.config, match.slots["list_id"])
    entries = []
    for card in cards:
        dirname = card_dirname(card)
        entries.append((dirname,
                        IndexEntry(
                            id=card["id"],
                            name=card.get("name") or card["id"],
                            resource_type="trello/card",
                            remote_time=card.get("dateLastActivity") or "",
                            vfs_name=dirname,
                        )))
    return entries


async def _list_card(accessor: TrelloAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]] | None:
    card = await find_card(accessor.config, match.slots)
    if card is None:
        return None
    # card.json's normalizer only uses fields the card listing already
    # carries, so its exact size is free here; comments.jsonl needs a
    # per-card actions call and stays size-unknown.
    remote_time = card.get("dateLastActivity") or ""
    return [
        ("card.json",
         IndexEntry(
             id=card["id"],
             name="card.json",
             resource_type="trello/card_json",
             vfs_name="card.json",
             size=len(to_json_bytes(normalize_card(card))),
             remote_time=remote_time,
         )),
        ("comments.jsonl",
         IndexEntry(
             id=card["id"],
             name="comments.jsonl",
             resource_type="trello/comments_jsonl",
             vfs_name="comments.jsonl",
             remote_time=remote_time,
         )),
    ]


readdir = make_readdir(
    detect_scope,
    listers={
        "workspaces": _list_workspaces_dir,
        "workspace": _list_workspace,
        "boards": _list_boards,
        "board": _list_board,
        "members": _list_members,
        "labels": _list_labels,
        "lists": _list_lists,
        "list": _list_list,
        "cards": _list_cards,
        "card": _list_card,
    },
    static_root=("workspaces", ),
)
