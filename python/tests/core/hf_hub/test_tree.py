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

from unittest.mock import patch

import pytest

from mirage.cache.index import NULL_INDEX
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.tree import (collect, ensure_live_index, ensure_tree,
                                     fetch_tree, index_rows, next_cursor,
                                     parse_entry, refill_index, tree_url)
from tests.core.hf_hub.conftest import dir_row, file_row, page


def test_parse_entry_keeps_the_lfs_content_size_not_the_pointer():
    """The pointer size is the trap this backend must never report.

    An LFS row carries both: `size` is the real content length and
    `lfs.pointerSize` is the 135-byte stub git actually stores. Reporting
    the stub makes wc -c and ls -l lie and risks a truncated copy.
    """
    entry = parse_entry({
        "type": "file",
        "oid": "abc",
        "size": 4798702184,
        "path": "model.safetensors",
        "lfs": {
            "oid": "sha256hex",
            "size": 4798702184,
            "pointerSize": 135
        },
        "xetHash": "xethash",
    })
    assert entry.size == 4798702184
    assert entry.lfs_oid == "sha256hex"
    assert entry.xet_hash == "xethash"


def test_parse_entry_reads_the_last_commit_when_expanded():
    entry = parse_entry({
        "type": "file",
        "oid": "abc",
        "size": 1,
        "path": "f",
        "lastCommit": {
            "id": "c1",
            "title": "t",
            "date": "2025-01-01T00:00:00.000Z"
        },
    })
    assert entry.last_modified == "2025-01-01T00:00:00.000Z"
    assert entry.last_commit == "c1"


def test_parse_entry_leaves_mtime_empty_without_expansion():
    entry = parse_entry(file_row("f"))
    assert entry.last_modified == ""


def test_next_cursor_reads_the_link_header():
    assert next_cursor({"link": '<https://h/next>; rel="next"'}) \
        == "https://h/next"


def test_next_cursor_is_empty_on_the_last_page():
    assert next_cursor({}) == ""
    assert next_cursor({"link": '<https://h/prev>; rel="prev"'}) == ""


def test_tree_url_appends_the_key_prefix(accessor, prefixed):
    """The prefix is normalized with a trailing slash, and the tree
    endpoint reads a trailing slash as another path segment."""
    assert tree_url(accessor).endswith("/api/models/acme/widget/tree/main")
    assert prefixed.key_prefix == "sub/dir/"
    assert tree_url(prefixed).endswith("/tree/main/sub/dir")


def test_collect_strips_the_key_prefix():
    into = {}
    collect([file_row("sub/dir/a.txt")], "sub/dir/", into)
    assert list(into) == ["a.txt"]


def test_collect_drops_the_row_naming_the_prefix_itself():
    """A prefix mount's own directory is not a child of anything."""
    into = {}
    collect([dir_row("sub/dir"), file_row("sub/dir/a.txt")], "sub/dir/", into)
    assert list(into) == ["a.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_keeps_one_expanded_page(mock_get, accessor):
    """A repo that fits one expanded page gets mtimes for the same cost."""
    mock_get.return_value = page([
        {
            **file_row("a.txt"), "lastCommit": {
                "id": "c",
                "date": "2025-01-01T00:00:00.000Z"
            }
        },
    ])
    tree = await fetch_tree(accessor)
    assert mock_get.await_count == 1
    assert mock_get.await_args.args[2]["expand"] == "true"
    assert tree["a.txt"].last_modified == "2025-01-01T00:00:00.000Z"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_falls_back_to_a_bare_walk_when_it_does_not_fit(
        mock_get, accessor):
    """Expansion drops the page from 1000 rows to 50, so a repo too big
    for one expanded page re-walks bare rather than paying twenty times
    the requests for mtimes."""
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        page([file_row("a.txt"), file_row("b.txt")]),
    ]
    tree = await fetch_tree(accessor)
    assert mock_get.await_count == 2
    assert mock_get.await_args_list[1].args[2]["expand"] == "false"
    assert sorted(tree) == ["a.txt", "b.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_forced_expansion_pages_through(mock_get, accessor):
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": True})
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        page([file_row("b.txt")]),
    ]
    tree = await fetch_tree(accessor)
    assert mock_get.await_count == 2
    # The second call follows the cursor and sends no params of its own.
    assert mock_get.await_args_list[1].args[1] == "https://h/p2"
    assert mock_get.await_args_list[1].args[2] is None
    assert sorted(tree) == ["a.txt", "b.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_forced_bare_never_expands(mock_get, accessor):
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": False})
    mock_get.return_value = page([file_row("a.txt")])
    await fetch_tree(accessor)
    assert mock_get.await_count == 1
    assert mock_get.await_args.args[2]["expand"] == "false"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
@pytest.mark.parametrize("status", [401, 403, 404])
async def test_fetch_tree_reads_absence_as_an_empty_tree(
        mock_get, accessor, status):
    """The Hub answers 401 rather than 404 for a repo an anonymous
    caller may not know exists, so all three mean the same thing here."""
    mock_get.side_effect = HfHubError("nope", status)
    assert await fetch_tree(accessor) == {}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_reraises_a_real_failure(mock_get, accessor):
    mock_get.side_effect = HfHubError("boom", 500)
    with pytest.raises(HfHubError):
        await fetch_tree(accessor)


def test_index_rows_gives_the_root_a_listing_for_an_empty_repo():
    """Without it an empty repository is byte for byte a dropped index."""
    entries, children = index_rows({}, "")
    assert entries == {}
    assert children == {"/": []}


def test_index_rows_keys_mount_absolute_under_a_prefix():
    tree = {"a.txt": parse_entry(file_row("a.txt", 7))}
    entries, children = index_rows(tree, "/m")
    assert entries["/m/a.txt"].size == 7
    assert children["/m"] == ["/m/a.txt"]


def test_index_rows_implies_a_parent_a_page_boundary_split_off():
    """A cursor can deliver a child before its own directory row."""
    tree = {"d/a.txt": parse_entry(file_row("d/a.txt"))}
    entries, children = index_rows(tree, "")
    assert children["/d"] == ["/d/a.txt"]
    assert "/d" not in entries


def test_index_rows_leaves_a_directory_size_unset():
    tree = {"d": parse_entry(dir_row("d"))}
    entries, _ = index_rows(tree, "")
    assert entries["/d"].size is None
    assert entries["/d"].resource_type == "folder"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.fetch_tree")
async def test_refill_index_is_a_noop_without_an_index(mock_fetch, accessor):
    assert await refill_index(accessor, NULL_INDEX, "") is False
    mock_fetch.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.fetch_tree")
async def test_refill_index_clears_the_derived_row_memo(mock_fetch, accessor):
    mock_fetch.return_value = {"a.txt": parse_entry(file_row("a.txt"))}
    accessor.rows_cache = ("", {}, {})
    assert await refill_index(accessor, RAMIndexCacheStore(), "") is True
    assert accessor.rows_cache is None
    assert accessor.tree_loaded is True


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.fetch_tree")
async def test_ensure_live_index_refetches_a_dropped_index(
        mock_fetch, accessor):
    mock_fetch.return_value = {"a.txt": parse_entry(file_row("a.txt"))}
    index = RAMIndexCacheStore()
    assert await ensure_live_index(accessor, index, "") is True
    # Live now: a second call must cost no request.
    assert await ensure_live_index(accessor, index, "") is False
    assert mock_fetch.await_count == 1


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.fetch_tree")
async def test_ensure_tree_hydrates_an_empty_repo_exactly_once(
        mock_fetch, accessor):
    """An empty repository hydrates to {}; reading that as 'not
    hydrated' refetches it on every call forever."""
    mock_fetch.return_value = {}
    await ensure_tree(accessor)
    await ensure_tree(accessor)
    assert mock_fetch.await_count == 1
