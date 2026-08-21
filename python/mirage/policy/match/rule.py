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
from mirage.policy.types import (AdmissionRules, CommandContext, CommandRule,
                                 OpsContext)
from mirage.types import HiddenPaths
from mirage.utils.hidden import (anchor_depth, classify_paths, path_covers,
                                 path_hidden)

# Which verb wins when two rules speak at the same anchor depth: deny
# before ask. Both gates order by it, which is what keeps the entry
# gate from contradicting the admission gate.
DENY_FIRST = 0
ASK_SECOND = 1


def better_match(current: tuple[int, int] | None, depth: int,
                 verb: int) -> bool:
    """Whether a match beats the best one so far: deeper anchor first,
    then the stronger verb, then the earlier rule (which is why this is
    strict).

    Shared by ``decide`` and :func:`io_refusal` so a line and the
    entries it reaches mid-walk are read by one law.

    Args:
        current (tuple[int, int] | None): the best (depth, verb) so far.
        depth (int): the candidate's anchor depth.
        verb (int): ``DENY_FIRST`` or ``ASK_SECOND``.
    """
    if current is None:
        return True
    best_depth, best_verb = current
    if depth != best_depth:
        return depth > best_depth
    return verb < best_verb


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
        depth (int): the anchor depth of the deepest entry that
            actually covered the operand, which is what the path axis
            orders by. Scoring the rule's deepest entry instead would
            lend an unrelated entry's depth to this match: an ask on
            ``/repo/*`` and ``/else/very/deep/*`` would outrank a deny
            anchored at ``/repo/private/*`` and reopen it. 0 when the
            rule names no paths, which is off the path axis entirely.
    """

    operand: str | None
    depth: int = 0


def _under(path: str, root: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")


def _touches(mount: str, ctx: CommandContext) -> bool:
    """Whether a line works inside a mount: its cwd is under the root,
    one of its paths is, or the command walks a directory holding the
    root (``grep -r x /scratch`` enters ``/scratch/child``: the fan-out
    reruns the traversal inside each descendant mount and no admission
    fires again there, so the ancestor operand is the one place the
    mount's rule can speak).

    Args:
        mount (str): the mount root.
        ctx (CommandContext): the classified command.
    """
    if _under(ctx.cwd, mount):
        return True
    if any(_under(p.virtual, mount) for p in ctx.paths):
        return True
    return ctx.walks and any(_under(mount, p.virtual) for p in ctx.paths)


def match_rule(rule: CommandRule, scope: HiddenPaths | None,
               ctx: CommandContext) -> RuleMatch | None:
    """Whether a rule applies to a line, and to which operand.

    Three questions in order: the rule's command patterns (a prefix
    of the line's tokens; none means every command), the rule's mount
    (a rule written under a mount section applies only to a line
    working inside it), the
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
            return RuleMatch(operand=p.raw_path or p.virtual,
                             depth=hidden_depth(rule, p.virtual))
    return _subtree_match(rule, scope, ctx)


def _subtree_match(rule: CommandRule, scope: HiddenPaths,
                   ctx: CommandContext) -> RuleMatch | None:
    """The operand of a subtree command that holds the scope, if any.

    ``rm -r /x`` and ``mv /x /y`` take ``/x/locked/*`` along, so for
    the commands in ``SUBTREE_COMMANDS`` an operand at or above the
    directory holding the scope matches like an operand inside it.
    ``mv``'s last operand is its destination, which only matches when
    it is that directory itself (moving into ``/x/locked`` lands in
    the scope; moving into ``/x`` does not).

    Args:
        rule (CommandRule): the rule, read for the entry that matched.
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
            return RuleMatch(operand=p.raw_path or p.virtual,
                             depth=covers_depth(rule, p.virtual))
    if dst is not None and path_covers(scope, dst.virtual, ancestors=False):
        return RuleMatch(operand=dst.raw_path or dst.virtual,
                         depth=covers_depth(rule, dst.virtual,
                                            ancestors=False))
    return None


@functools.lru_cache(maxsize=1024)
def _entry_scope(entry: str) -> HiddenPaths | None:
    """One document entry, classified alone so it can be scored on its
    own; remembered, since a rule is re-read on every line.

    Args:
        entry (str): one entry of a rule's ``paths``.
    """
    return classify_paths((entry, ))


def hidden_depth(rule: CommandRule, virtual: str) -> int:
    """The anchor depth of the deepest entry of a rule that holds this
    path, 0 when none does.

    Args:
        rule (CommandRule): the rule that matched.
        virtual (str): absolute virtual path the rule matched on.
    """
    return max((anchor_depth(e)
                for e in rule.paths if path_hidden(_entry_scope(e), virtual)),
               default=0)


def covers_depth(rule: CommandRule,
                 virtual: str,
                 ancestors: bool = True) -> int:
    """The anchor depth of the deepest entry of a rule that sits at or
    under this path, 0 when none does.

    The subtree counterpart of :func:`hidden_depth`, for an operand
    that would take the scope along rather than lie inside it.

    Args:
        rule (CommandRule): the rule that matched.
        virtual (str): absolute virtual path of the subtree operand.
        ancestors (bool): whether an ancestor of the scope counts.
    """
    return max((anchor_depth(e) for e in rule.paths
                if path_covers(_entry_scope(e), virtual, ancestors)),
               default=0)


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


def io_refusal(rules: AdmissionRules | None, tokens: Sequence[str],
               virtual: str, granted: Collection[CommandRule]) -> str | None:
    """The reason a command may not touch an entry it reached on its
    own, None when it may.

    The same law the admission gate applies to a line, and literally
    the same comparison (:func:`better_match`): anchor depth first,
    deny before ask at equal depth. Reading every deny before any ask
    instead would let a broad deny on ``/repo/*`` overrule an approved
    ask on ``/repo/sealed/*`` that the gate had just admitted the line
    under, so the carve-out would survive admission and then refuse
    every entry it was written for.

    The winning rule then answers: a deny refuses, an ask refuses
    unless the line holds a grant under it (the nod the gate took for
    ``rm -r /x`` covers the entries under ``/x``; a walk that wanders
    into an asked scope from outside gets no nod mid-command, so it is
    refused and the agent names the path to be asked).

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        tokens (Sequence[str]): the line's tokens, command name first.
        virtual (str): absolute virtual path of the entry.
        granted (Collection[CommandRule]): the ask rules the line runs
            under a grant for.
    """
    if rules is None:
        return None
    best: tuple[int, int] | None = None
    chosen: tuple[CommandRule, int] | None = None
    for verb, written in ((DENY_FIRST, rules.deny), (ASK_SECOND, rules.ask)):
        for rule in written:
            if not match_io(rule, rule_scope(rule), tokens, virtual):
                continue
            depth = hidden_depth(rule, virtual)
            if not better_match(best, depth, verb):
                continue
            best = (depth, verb)
            chosen = (rule, verb)
    if chosen is None:
        return None
    rule, verb = chosen
    if verb == ASK_SECOND and rule in granted:
        return None
    return rule.reason


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
