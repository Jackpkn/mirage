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

from mirage.policy.match.allow import line_tokens
from mirage.policy.match.pattern import pattern_matches
from mirage.policy.types import CommandContext, CommandRule, OpsContext
from mirage.types import HiddenPaths
from mirage.utils.hidden import path_hidden


@dataclass(frozen=True, slots=True)
class RuleMatch:
    """A rule that applies to a line, and how far it reaches.

    ``match_rule`` returns None when the rule does not apply, a
    RuleMatch with ``operand`` None when the rule refuses (or asks
    about) the whole line, and a RuleMatch naming the operand when the
    rule is path-scoped and one operand fell under its paths, so the
    refusal is scoped to that operand (``rm: x: <reason>``, exit 1)
    rather than to the command (``rm: policy denied: <reason>``, 126).

    Args:
        operand (str | None): the operand as typed that a path-scoped
            rule matched; None when the rule reaches the whole line.
    """

    operand: str | None


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


def match_rule(rule: CommandRule, scope: HiddenPaths | None,
               ctx: CommandContext) -> RuleMatch | None:
    """Whether a rule applies to a line, and to which operand.

    Three questions in order: the rule's command patterns (a prefix
    of the line's tokens; none means every command), the rule's mount
    (a mount-tier rule applies only to a line working inside it), the
    rule's paths (none means the whole line; otherwise the first
    operand under them scopes the match).

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
        return RuleMatch(operand=None)
    for p in ctx.paths:
        if path_hidden(scope, p.virtual):
            return RuleMatch(operand=p.raw_path or p.virtual)
    return None


def match_op(rule: CommandRule, scope: HiddenPaths | None,
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
