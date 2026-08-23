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

from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType

# A page tree nests arbitrarily, so the page level is one VARIADIC slot:
# `pages/a__1/b__2` is a page at any depth, and the slots hold the DEEPEST
# page's label and id, which is the one the path addresses. Under
# `databases/` the same run starts below the data source, because a row
# page is an ordinary page whose parent is the data source.
_PAGE = Slot("page", id_key="page_id", variadic=True)
_DB = ("databases", Slot("database", id_key="database_id"))
_DS = _DB + (Slot("data_source", id_key="data_source_id"), )

# One description of the tree: readdir, stat and read all classify
# through it, so the file surface cannot disagree with itself about what
# a path means. The `page` and `page_json` kinds are declared twice, once
# per root, because a page behaves identically wherever it hangs.
SCOPES = (
    Scope(kind="pages", segments=("pages", ), probed=False),
    Scope(kind="databases", segments=("databases", ), probed=False),
    Scope(kind="page_json",
          segments=("pages", _PAGE, "page.json"),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="page", segments=("pages", _PAGE)),
    Scope(kind="database_json",
          segments=_DB + ("database.json", ),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="database", segments=_DB),
    Scope(kind="data_source_json",
          segments=_DS + ("data_source.json", ),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="data_source", segments=_DS),
    Scope(kind="page_json",
          segments=_DS + (_PAGE, "page.json"),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="page", segments=_DS + (_PAGE, )),
)

detect_scope = make_detect_scope(SCOPES)
