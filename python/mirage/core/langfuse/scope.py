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

from mirage.core.hierarchy.codec import INT_JSON, JSON_NAME, JSONL_NAME
from mirage.core.hierarchy.route import Capture, Route
from mirage.core.hierarchy.scope import make_detect_scope
from mirage.types import FileType

TOP_LEVEL_DIRS = ["traces", "sessions", "prompts", "datasets"]

# One description of the tree: readdir, stat, read AND the grep/rg
# search push-down all classify through it, so the file surface and the
# search surface cannot disagree about what a path means (they used to
# be two hand-maintained dispatch ladders).
ROUTES = (
    Route(kind="traces", segments=("traces", ), probed=False),
    Route(kind="trace",
          segments=("traces", Capture("trace_id", JSON_NAME)),
          leaf=True,
          filetype=FileType.JSON),
    Route(kind="sessions", segments=("sessions", ), probed=False),
    Route(kind="session", segments=("sessions", Capture("session_id"))),
    Route(kind="session_trace",
          segments=("sessions", Capture("session_id"),
                    Capture("trace_id", JSON_NAME)),
          leaf=True,
          filetype=FileType.JSON),
    Route(kind="prompts", segments=("prompts", ), probed=False),
    Route(kind="prompt", segments=("prompts", Capture("prompt_name"))),
    # A version that is not a plain ASCII integer cannot name a prompt
    # version, so it fails the route match and reads as ENOENT instead
    # of an int() crash (python) or a digit-prefix guess (typescript).
    Route(kind="prompt_version",
          segments=("prompts", Capture("prompt_name"),
                    Capture("version", INT_JSON)),
          leaf=True,
          filetype=FileType.JSON),
    Route(kind="datasets", segments=("datasets", ), probed=False),
    Route(kind="dataset", segments=("datasets", Capture("dataset_name"))),
    Route(kind="dataset_items",
          segments=("datasets", Capture("dataset_name"), "items.jsonl"),
          leaf=True,
          filetype=FileType.TEXT),
    Route(kind="runs",
          segments=("datasets", Capture("dataset_name"), "runs")),
    Route(kind="dataset_run",
          segments=("datasets", Capture("dataset_name"), "runs",
                    Capture("run_name", JSONL_NAME)),
          leaf=True,
          filetype=FileType.TEXT),
)

detect_scope = make_detect_scope(ROUTES)

# The kinds the grep/rg push-down may answer with a whole-container
# search; leaves and unrecognized paths fall through to the generic
# per-file scan.
SEARCH_KINDS = {
    "root": "traces",
    "traces": "traces",
    "sessions": "sessions",
    "session": "sessions",
    "prompts": "prompts",
    "prompt": "prompts",
    "datasets": "datasets",
    "dataset": "datasets",
}
