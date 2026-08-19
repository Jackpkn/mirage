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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gdocs.client import TokenManager, docs_base, google_get
from mirage.core.gdocs.readdir import readdir
from mirage.core.gdocs.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import compact_json_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_doc(token_manager: TokenManager, doc_id: str) -> bytes:
    url = f"{docs_base(token_manager)}/documents/{doc_id}"
    data = await google_get(token_manager, url)
    return compact_json_bytes(data)


async def _read_file(accessor: GDocsAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    return await read_doc(accessor.token_manager, entry.id)


read = make_read(detect_scope, readers={"file": _read_file})
