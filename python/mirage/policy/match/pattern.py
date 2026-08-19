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

from collections.abc import Sequence

from mirage.policy.constants import WILDCARD


def split_pattern(pattern: str) -> tuple[str, ...]:
    """A command pattern's tokens.

    Whitespace-split; trailing wildcards are dropped because a pattern
    is a prefix and already matches any continuation (``git *`` and
    ``git`` are the same rule; a bare ``*`` is every command).

    Args:
        pattern (str): the pattern as written in the document.
    """
    tokens = tuple(pattern.split())
    while tokens and tokens[-1] == WILDCARD:
        tokens = tokens[:-1]
    return tokens


def pattern_matches(pattern: str, tokens: Sequence[str]) -> bool:
    """Whether a pattern is a prefix of a line's tokens.

    Args:
        pattern (str): the pattern as written.
        tokens (Sequence[str]): the line as the door normalized it,
            command name first.
    """
    want = split_pattern(pattern)
    if len(want) > len(tokens):
        return False
    return all(w == WILDCARD or w == t for w, t in zip(want, tokens))


def pattern_names(pattern: str, name: str) -> bool:
    """Whether a pattern can match some line of a command.

    Visibility asks this: a name is installed for the session when a
    pattern of every allow list starts with it (or with the wildcard),
    whatever the rest of the pattern requires of the line.

    Args:
        pattern (str): the pattern as written.
        name (str): the command name.
    """
    want = split_pattern(pattern)
    return not want or want[0] == WILDCARD or want[0] == name


def _unify(a: tuple[str, ...], b: tuple[str, ...]) -> tuple[str, ...] | None:
    out: list[str] = []
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else None
        y = b[i] if i < len(b) else None
        if x is None:
            out.append(y or WILDCARD)
        elif y is None:
            out.append(x)
        elif x == y or y == WILDCARD:
            out.append(x)
        elif x == WILDCARD:
            out.append(y)
        else:
            return None
    return tuple(out)


def intersect_patterns(a: Sequence[str], b: Sequence[str]) -> tuple[str, ...]:
    """The allow list both lists grant: every pair unified token by
    token, the longer prefix winning where one extends the other and
    a wildcard yielding to the concrete token.

    Args:
        a (Sequence[str]): one allow list.
        b (Sequence[str]): the other.
    """
    out: list[str] = []
    for x in a:
        for y in b:
            joined = _unify(split_pattern(x), split_pattern(y))
            if joined is None:
                continue
            text = " ".join(joined) or WILDCARD
            if text not in out:
                out.append(text)
    return tuple(out)
