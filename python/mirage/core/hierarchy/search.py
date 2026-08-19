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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import ScopeMatch


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """One qualified grep/rg push-down request.

    Args:
        pattern (str): the resolved pattern list, as the line typed it.
        ignore_case (bool): -i.
        fixed_string (bool): -F.
        whole_word (bool): -w.
    """
    pattern: str
    ignore_case: bool = False
    fixed_string: bool = False
    whole_word: bool = False


Searcher = Callable[[A, ScopeMatch, SearchQuery], Awaitable[list[str]]]
