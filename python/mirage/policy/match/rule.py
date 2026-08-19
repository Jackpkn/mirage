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

import functools
from collections.abc import Collection, Sequence
from dataclasses import dataclass

from mirage.policy.constants import METADATA_OPS, SUBTREE_COMMANDS, SUBTREE_OPS
from mirage.policy.match.allow import line_tokens
from mirage.policy.match.pattern import pattern_matches
from mirage.policy.types import (CommandContext, CommandRule, CommandsSpec,
                                 OpsContext)
from mirage.types import HiddenPaths
from mirage.utils.hidden import classify_paths, path_covers, path_hidden


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
    return _subtree_match(scope, ctx)


def _subtree_match(scope: HiddenPaths,
                   ctx: CommandContext) -> RuleMatch | None:
    """The operand of a subtree command that holds the scope, if any.

    ``rm -r /x`` and ``mv /x /y`` take ``/x/locked/*`` along, so for
    the commands in ``SUBTREE_COMMANDS`` an operand at or above the
    directory holding the scope matches like an operand inside it.
    ``mv``'s last operand is its destination, which only matches when
    it is that directory itself (moving into ``/x/locked`` lands in
    the scope; moving into ``/x`` does not).

    Args:
        scope (HiddenPaths): the rule's classified paths.
        ctx (CommandContext): the classified command.
    """
    if ctx.command not in SUBTREE_COMMANDS:
        return None
    operands = list(ctx.operands)
    dst = (operands.pop()
           if ctx.command == "mv" and len(operands) > 1 else None)
    for p in operands:
        if path_covers(scope, p.virtual):
            return RuleMatch(operand=p.raw_path or p.virtual)
    if dst is not None and path_covers(scope, dst.virtual, ancestors=False):
        return RuleMatch(operand=dst.raw_path or dst.virtual)
    return None


@functools.lru_cache(maxsize=1024)
def rule_scope(rule: CommandRule) -> HiddenPaths | None:
    """A rule's paths, classified once and remembered: None when the
    rule names none, so a caller can tell a whole-line rule from a
    path-scoped one without re-reading the document grammar.

    Args:
        rule (CommandRule): the rule, which is frozen and so a key.
    """
    return classify_paths(rule.paths)


def match_io(rule: CommandRule, scope: HiddenPaths | None,
             tokens: Sequence[str], virtual: str) -> bool:
    """Whether a rule reaches an entry a command touches on its own,
    below its operands: the rule names the line (its command patterns
    against the line's tokens, none meaning every command) and its
    paths hold the entry. A rule with no paths spoke about the whole
    line at admission and has nothing to add at an entry; the
    directory holding a scope is not in it, so a listing still shows
    a refused entry's name, which is what deny means: present, and
    refused.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's classified paths.
        tokens (Sequence[str]): the line as an admission pattern reads
            it, command name first.
        virtual (str): absolute virtual path of the entry.
    """
    if scope is None:
        return False
    if rule.commands and not any(
            pattern_matches(p, tokens) for p in rule.commands):
        return False
    return path_hidden(scope, virtual)


def io_refusal(layers: Sequence[CommandsSpec], tokens: Sequence[str],
               virtual: str, granted: Collection[CommandRule]) -> str | None:
    """The reason a command may not touch an entry it reached on its
    own, None when it may.

    The same precedence the admission gate applies to a line: the deny
    rules in tier order, the first that reaches the entry refusing it;
    then the ask rules in tier order, where the first that reaches it
    refuses unless the line holds a grant under that rule (the nod the
    gate took for ``rm -r /x`` covers the entries under ``/x``; a walk
    that wanders into an asked scope from outside gets no nod
    mid-command, so it is refused and the agent names the path to be
    asked).

    Args:
        layers (Sequence[CommandsSpec]): the session's command tiers.
        tokens (Sequence[str]): the line's tokens, command name first.
        virtual (str): absolute virtual path of the entry.
        granted (Collection[CommandRule]): the ask rules the line runs
            under a grant for.
    """
    for spec in layers:
        for rule in spec.deny:
            if match_io(rule, rule_scope(rule), tokens, virtual):
                return rule.reason
    for spec in layers:
        for rule in spec.ask:
            if match_io(rule, rule_scope(rule), tokens, virtual):
                return None if rule in granted else rule.reason
    return None


def match_op(rule: CommandRule, scope: HiddenPaths | None,
             ctx: OpsContext) -> bool:
    """Whether a rule refuses an op: only a pure path rule can, since an
    op does not know which command issued it. The op's path is tested
    against the scope, and an op that moves or removes a whole subtree
    (``SUBTREE_OPS``) is also refused on the directory holding the
    scope or on any ancestor, since it would take the scope along. A
    metadata op (``METADATA_OPS``) passes: deny is present and refused,
    so the entry stats and its content is what the door withholds.

    Args:
        rule (CommandRule): the rule.
        scope (HiddenPaths | None): the rule's classified paths.
        ctx (OpsContext): the op about to run.
    """
    if rule.commands or scope is None or ctx.op in METADATA_OPS:
        return False
    if path_hidden(scope, ctx.path.virtual):
        return True
    return ctx.op in SUBTREE_OPS and path_covers(scope, ctx.path.virtual)
