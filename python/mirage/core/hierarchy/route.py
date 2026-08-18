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

from dataclasses import dataclass

from mirage.core.hierarchy.codec import RAW, Codec
from mirage.types import FileType


@dataclass(frozen=True, slots=True)
class Capture:
    """One dynamic segment of a route.

    Args:
        name (str): key the decoded value is stored under.
        codec (Codec): how the segment encodes the value.
    """
    name: str
    codec: Codec = RAW


Segment = str | Capture


@dataclass(frozen=True, slots=True)
class Route:
    """One addressable position in a fixed API hierarchy.

    Args:
        kind (str): the position's name; listers, probes and readers key
            on it.
        segments (tuple[Segment, ...]): the path shape, literals and
            captures.
        leaf (bool): whether the position is a file rather than a
            directory.
        filetype (FileType | None): rendered type of a leaf; None on
            directories.
        probed (bool): whether stat must prove existence (parent listing
            by default); False for positions that exist by construction,
            like the top-level directories.
    """
    kind: str
    segments: tuple[Segment, ...]
    leaf: bool = False
    filetype: FileType | None = None
    probed: bool = True


def match_route(
        routes: tuple[Route, ...],
        parts: list[str]) -> tuple[Route, dict[str, str]] | None:
    """Match path segments against the table, first declared route wins.

    Args:
        routes (tuple[Route, ...]): the backend's route table.
        parts (list[str]): non-empty path segments.
    """
    for route in routes:
        if len(route.segments) != len(parts):
            continue
        captures: dict[str, str] = {}
        matched = True
        for segment, part in zip(route.segments, parts):
            if isinstance(segment, str):
                if part != segment:
                    matched = False
                    break
                continue
            decoded = segment.codec.decode(part)
            if decoded is None:
                matched = False
                break
            captures[segment.name] = decoded
        if matched:
            return route, captures
    return None
