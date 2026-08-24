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

import lancedb
import pytest

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.lancedb.readdir import readdir
from mirage.resource.lancedb.config import LanceDBConfig
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _names(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in paths}


@pytest.mark.asyncio
async def test_root_lists_table(accessor):
    out = await readdir(accessor, _ps("/"))
    assert _names(out) == {"animals"}


@pytest.mark.asyncio
async def test_table_lists_groups(accessor):
    out = await readdir(accessor, _ps("/animals"))
    assert _names(out) == {"cat", "dog"}


@pytest.mark.asyncio
async def test_group_lists_next_level(accessor):
    out = await readdir(accessor, _ps("/animals/cat"))
    assert _names(out) == {"big", "small"}


@pytest.mark.asyncio
async def test_leaf_lists_row_files(accessor):
    out = await readdir(accessor, _ps("/animals/cat/big"))
    assert _names(out) == {"1.md", "1.png"}


def _globbed(path: str, pattern: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"),
                    pattern=pattern)


CAP = 5
WIDE = 40


@pytest.fixture
def capped(tmp_path) -> LanceDBAccessor:
    """A table wider than its own row cap, in one group.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    uri = str(tmp_path / "wide")
    db = lancedb.connect(uri)
    db.create_table("wide",
                    data=[{
                        "id": f"doc-{i:03d}",
                        "label": "all",
                        "name": f"n{i}",
                        "vector": [0.1, 0.2],
                    } for i in range(WIDE)])
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      table="wide",
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name",
                      max_rows=CAP))


@pytest.mark.asyncio
async def test_a_row_glob_reaches_past_the_cap(capped):
    # The cap covers doc-000..doc-004, so filtering it would answer
    # nothing; the prefix goes into the query instead.
    out = await readdir(capped, _globbed("/all", "doc-03*"))
    assert _names(out) == {f"doc-03{i}.md" for i in range(CAP)}


@pytest.mark.asyncio
async def test_a_glob_with_no_literal_head_stays_capped(capped):
    # Neither backend can narrow on a leading metacharacter, so this one
    # is the ordinary capped listing that the glob then filters.
    out = await readdir(capped, _globbed("/all", "*9.md"))
    assert _names(out) == {f"doc-00{i}.md" for i in range(CAP)}


@pytest.mark.asyncio
async def test_a_narrowed_listing_is_not_cached_as_the_directory(capped):
    index = RAMIndexCacheStore()
    await readdir(capped, _globbed("/all", "doc-03*"), index)
    listing = await index.list_dir("/all/")
    assert listing.entries is None
    plain = await readdir(capped, _ps("/all"), index)
    assert _names(plain) == {f"doc-00{i}.md" for i in range(CAP)}


@pytest.fixture
def underscored(tmp_path) -> LanceDBAccessor:
    """Ids whose own text contains a LIKE metacharacter.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    uri = str(tmp_path / "meta")
    db = lancedb.connect(uri)
    db.create_table("meta",
                    data=[{
                        "id": rid,
                        "label": "all",
                        "name": rid,
                        "vector": [0.1, 0.2],
                    } for rid in ("doc_1", "doc_2", "docX1", "a%b", "axb")])
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      table="meta",
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name",
                      max_rows=2))


@pytest.mark.asyncio
async def test_a_like_metacharacter_in_the_prefix_is_escaped(underscored):
    # An unescaped `_` is LIKE's single-character wildcard, so docX1 would
    # ride along and could crowd a real match out of the row cap.
    out = await readdir(underscored, _globbed("/all", "doc_*"))
    assert _names(out) == {"doc_1.md", "doc_2.md"}
    out = await readdir(underscored, _globbed("/all", "a%*"))
    assert _names(out) == {"a%b.md"}
