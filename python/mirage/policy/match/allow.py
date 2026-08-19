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

from mirage.policy.match.pattern import pattern_matches, pattern_names
from mirage.policy.types import CommandContext, CommandsSpec


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
