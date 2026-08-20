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

from mirage.policy.match.pattern import pattern_matches, pattern_names
from mirage.policy.types import AdmissionRules, CommandContext


def head_visible(name: str, rules: AdmissionRules | None) -> bool:
    """Whether a session can see a command at all.

    A role without an allow list hides nothing; a role with one hides
    every name none of its patterns start with. Grammar-tier builtins
    and shell functions are the caller's exemptions, not this one's.

    Args:
        name (str): the command name.
        rules (AdmissionRules | None): the session's admission rules.
    """
    if rules is None or rules.allow is None:
        return True
    return any(pattern_names(p, name) for p in rules.allow)


def line_tokens(ctx: CommandContext) -> tuple[str, ...]:
    """The tokens a pattern reads: the door's normalization when it set
    one, else the name and the raw argv (a context built by hand).

    Args:
        ctx (CommandContext): the classified command.
    """
    return ctx.tokens or (ctx.command, *ctx.argv)


def line_allowed(ctx: CommandContext, rules: AdmissionRules | None) -> bool:
    """Whether the role's allow list has a pattern for the line.

    A role that states no list installs everything. A word that is not
    a tool (``ctx.tool`` cleared by the door: shell grammar, the
    agent's own function, an executed path) is always allowed here; a
    deny rule is the only thing that can refuse it.

    Args:
        ctx (CommandContext): the classified command.
        rules (AdmissionRules | None): the session's admission rules.
    """
    if not ctx.tool or rules is None or rules.allow is None:
        return True
    tokens = line_tokens(ctx)
    return any(pattern_matches(p, tokens) for p in rules.allow)
