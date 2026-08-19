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
from dataclasses import dataclass

from mirage.policy.types import (CommandContext, CommandRule, CommandsSpec,
                                 OpsContext)
from mirage.types import HiddenPaths
from mirage.utils.hidden import path_hidden

# The one pattern token that matches any one line token; trailing, it
# matches whatever follows, which a prefix already does.
WILDCARD = "*"


@dataclass(frozen=True, slots=True)
class RuleHit:
    """A rule that applies to a line.

    Args:
        operand (str | None): the operand as typed that a path-scoped
            rule matched; None when the rule refuses the whole line.
    """

    operand: str | None


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


def head_visible(name: str, layers: Sequence[CommandsSpec]) -> bool:
    """Whether a session can see a command at all.

    A tier without an allow list hides nothing; a tier with one hides
    every name none of its patterns start with. Grammar-tier builtins
    and shell functions are the caller's exemptions, not this one's.

    Args:
        name (str): the command name.
        layers (Sequence[CommandsSpec]): the session's compiled tiers.
    """
    for spec in layers:
        if spec.allow is None:
            continue
        if not any(pattern_names(p, name) for p in spec.allow):
            return False
    return True


def line_tokens(ctx: CommandContext) -> tuple[str, ...]:
    """The tokens a pattern reads: the door's normalization when it set
    one, else the name and the raw argv (a context built by hand).

    Args:
        ctx (CommandContext): the classified command.
    """
    return ctx.tokens or (ctx.command, *ctx.argv)


def line_allowed(ctx: CommandContext, layers: Sequence[CommandsSpec]) -> bool:
    """Whether every tier with an allow list has a pattern for the line.

    A word that is not a tool (``ctx.tool`` cleared by the door: shell
    grammar, the agent's own function, an executed path) is always
    allowed here; a deny rule is the only thing that can refuse it.

    Args:
        ctx (CommandContext): the classified command.
        layers (Sequence[CommandsSpec]): the session's compiled tiers.
    """
    if not ctx.tool:
        return True
    tokens = line_tokens(ctx)
    for spec in layers:
        if spec.allow is None:
            continue
        if not any(pattern_matches(p, tokens) for p in spec.allow):
            return False
    return True


def _under(path: str, root: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")


def _touches(mount: str, ctx: CommandContext) -> bool:
    """Whether a line works inside a mount: its cwd is under the root
    or one of its paths is.

    Args:
        mount (str): the mount root.
        ctx (CommandContext): the classified command.
    """
    if _under(ctx.cwd, mount):
        return True
    return any(_under(p.virtual, mount) for p in ctx.paths)


def rule_hit(rule: CommandRule, scope: HiddenPaths | None,
             ctx: CommandContext) -> RuleHit | None:
    """Whether a rule applies to a line, and to which operand.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's paths, classified once
            through ``classify_paths``; None when the rule names none.
        ctx (CommandContext): the classified command.
    """
    if rule.commands:
        tokens = line_tokens(ctx)
        if not any(pattern_matches(p, tokens) for p in rule.commands):
            return None
    if rule.mount and not _touches(rule.mount, ctx):
        return None
    if scope is None:
        return RuleHit(operand=None)
    for p in ctx.paths:
        if path_hidden(scope, p.virtual):
            return RuleHit(operand=p.raw_path or p.virtual)
    return None


def op_hit(rule: CommandRule, scope: HiddenPaths | None,
           ctx: OpsContext) -> bool:
    """Whether a rule refuses an op: only a pure path rule can, since an
    op does not know which command issued it.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's classified paths.
        ctx (OpsContext): the op about to run.
    """
    if rule.commands or scope is None:
        return False
    return path_hidden(scope, ctx.path.virtual)


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
