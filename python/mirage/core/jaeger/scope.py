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

from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.route import Capture, Route
from mirage.core.hierarchy.scope import make_detect_scope
from mirage.core.jaeger.client import is_trace_id
from mirage.types import FileType

OPERATIONS_FILE = "operations.json"
TOP_LEVEL_DIRS = ["services"]

# A malformed id cannot name an existing trace, so it fails the route
# match outright and reads as ENOENT rather than the API's 400 "invalid
# length for TraceID".
TRACE_FILE = Codec(suffix=".json", validate=is_trace_id)

# The tree is service-scoped because Jaeger's search API requires a
# service: there is no endpoint that lists every trace.
ROUTES = (
    Route(kind="services", segments=("services", ), probed=False),
    Route(kind="service", segments=("services", Capture("service"))),
    Route(kind="operations",
          segments=("services", Capture("service"), OPERATIONS_FILE),
          leaf=True,
          filetype=FileType.JSON),
    Route(kind="traces", segments=("services", Capture("service"), "traces")),
    Route(kind="trace",
          segments=("services", Capture("service"), "traces",
                    Capture("trace_id", TRACE_FILE)),
          leaf=True,
          filetype=FileType.JSON),
)

detect_scope = make_detect_scope(ROUTES)
