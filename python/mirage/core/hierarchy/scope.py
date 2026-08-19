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

from mirage.core.hierarchy.codec import RAW, Codec
from mirage.types import FileType, PathSpec

ROOT = "root"
INVALID = "invalid"


@dataclass(frozen=True, slots=True)
class Slot:
    """One dynamic segment of a scope.

    Args:
        name (str): key the decoded value is stored under.
        codec (Codec): how the segment encodes the value.
        id_key (str | None): set for ``<label>__<id>`` composite segments:
            the decoded payload splits on its LAST ``__`` (so a three-part
            ``KEY__name__id`` keeps ``KEY__name`` as the label), the label
            stored under ``name`` and the id under ``id_key``. A payload
            with no ``__`` or an empty half does not match the scope.
    """
    name: str
    codec: Codec = RAW
    id_key: str | None = None


Segment = str | Slot


@dataclass(frozen=True, slots=True)
class Scope:
    """One addressable position in a fixed API hierarchy.

    Args:
        kind (str): the position's name; listers, probes and readers key
            on it.
        segments (tuple[Segment, ...]): the path shape, literals and
            slots.
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


DetectFn = Callable[[PathSpec | str], "ScopeMatch"]


@dataclass(frozen=True, slots=True)
class ScopeMatch:
    """Where in the hierarchy a path landed.

    Args:
        kind (str): the matched scope's kind, or ``root``/``invalid``.
        slots (dict[str, str]): decoded dynamic segments by name.
        resource_path (str): the raw path that was classified.
        scope (Scope | None): the matched scope; None for root and
            invalid.
    """
    kind: str
    resource_path: str
    slots: dict[str, str] = field(default_factory=dict)
    scope: Scope | None = None


def match_scope(scopes: tuple[Scope, ...],
                parts: list[str]) -> tuple[Scope, dict[str, str]] | None:
    """Match path segments against the table, first declared scope wins.

    Args:
        scopes (tuple[Scope, ...]): the backend's scope table.
        parts (list[str]): non-empty path segments.
    """
    for scope in scopes:
        if len(scope.segments) != len(parts):
            continue
        slots: dict[str, str] = {}
        matched = True
        for segment, part in zip(scope.segments, parts):
            if isinstance(segment, str):
                if part != segment:
                    matched = False
                    break
                continue
            decoded = segment.codec.decode(part)
            if decoded is None:
                matched = False
                break
            if segment.id_key is not None:
                label, sep, ident = decoded.rpartition("__")
                if not sep or not label or not ident:
                    matched = False
                    break
                slots[segment.name] = label
                slots[segment.id_key] = ident
                continue
            slots[segment.name] = decoded
        if matched:
            return scope, slots
    return None


def make_detect_scope(scopes: tuple[Scope, ...]) -> DetectFn:
    """Build a path classifier from a scope table.

    The classifier is the single description of the backend's tree:
    readdir, stat, read, and any search push-down all dispatch on its
    result, so the file surface and the command surface cannot disagree
    about what a path means. Hidden segments classify as invalid, which
    every consumer turns into ENOENT.

    Postgres's table, classified level by level::

        path                             kind         slots
        /                                root         {}
        /public                          schema       {schema}
        /public/tables                   kind         {schema, kind}
        /public/tables/books             entity       {schema, kind, entity}
        /public/tables/books/rows.jsonl  entity_rows  {schema, kind, entity}

    ``kind`` names the level a path landed on; the slots identify the
    branch taken at each dynamic level above it. Literal levels
    (``rows.jsonl``) contribute no slot, and one dynamic level can
    contribute two (``id_key``).

    Args:
        scopes (tuple[Scope, ...]): the backend's scope table, matched in
            declaration order.
    """

    def detect_scope(path: PathSpec | str) -> ScopeMatch:
        raw = path.mount_path if isinstance(path, PathSpec) else path
        key = raw.strip("/")
        if not key:
            return ScopeMatch(kind=ROOT, resource_path=raw)
        parts = key.split("/")
        if any(p.startswith(".") for p in parts):
            return ScopeMatch(kind=INVALID, resource_path=raw)
        matched = match_scope(scopes, parts)
        if matched is None:
            return ScopeMatch(kind=INVALID, resource_path=raw)
        scope, slots = matched
        return ScopeMatch(kind=scope.kind,
                          resource_path=raw,
                          slots=slots,
                          scope=scope)

    return detect_scope
