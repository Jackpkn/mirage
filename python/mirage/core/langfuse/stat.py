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

from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.langfuse.readdir import readdir
from mirage.core.langfuse.scope import detect_scope


def _session_extra(match: ScopeMatch) -> dict[str, str]:
    return {"session_id": match.slots["session_id"]}


def _prompt_extra(match: ScopeMatch) -> dict[str, str]:
    return {"prompt_name": match.slots["prompt_name"]}


def _dataset_extra(match: ScopeMatch) -> dict[str, str]:
    return {"dataset_name": match.slots["dataset_name"]}


stat = make_stat(
    detect_scope,
    readdir,
    extras={
        "session": _session_extra,
        "prompt": _prompt_extra,
        "dataset": _dataset_extra,
    },
)
