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

from collections.abc import Callable
from dataclasses import dataclass, field

from mirage.core.hierarchy.route import Route, match_route
from mirage.types import PathSpec

ROOT = "root"
INVALID = "invalid"

DetectFn = Callable[[PathSpec | str], "RouteMatch"]


@dataclass(frozen=True, slots=True)
class RouteMatch:
    """Where in the hierarchy a path landed.

    Args:
        kind (str): the matched route's kind, or ``root``/``invalid``.
        captures (dict[str, str]): decoded dynamic segments by name.
        resource_path (str): the raw path that was classified.
        route (Route | None): the matched route; None for root and
            invalid.
    """
    kind: str
    resource_path: str
    captures: dict[str, str] = field(default_factory=dict)
    route: Route | None = None


def make_detect_scope(routes: tuple[Route, ...]) -> DetectFn:
    """Build a path classifier from a route table.

    The classifier is the single description of the backend's tree:
    readdir, stat, read, and any search push-down all dispatch on its
    result, so the file surface and the command surface cannot disagree
    about what a path means. Hidden segments classify as invalid, which
    every consumer turns into ENOENT.

    Args:
        routes (tuple[Route, ...]): the backend's route table, matched in
            declaration order.
    """

    def detect_scope(path: PathSpec | str) -> RouteMatch:
        raw = path.mount_path if isinstance(path, PathSpec) else path
        key = raw.strip("/")
        if not key:
            return RouteMatch(kind=ROOT, resource_path=raw)
        parts = key.split("/")
        if any(p.startswith(".") for p in parts):
            return RouteMatch(kind=INVALID, resource_path=raw)
        matched = match_route(routes, parts)
        if matched is None:
            return RouteMatch(kind=INVALID, resource_path=raw)
        route, captures = matched
        return RouteMatch(kind=route.kind,
                          resource_path=raw,
                          captures=captures,
                          route=route)

    return detect_scope
