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
from enum import StrEnum

from mirage.policy.match.allow import line_allowed
from mirage.policy.match.rule import match_rule, rule_scope
from mirage.policy.types import AdmissionRules, CommandContext, CommandRule
from mirage.utils.hidden import is_glob


class Outcome(StrEnum):
    """What the role's rules say about one line.

    RUN is silence: no rule spoke. NOT_ALLOWED is the allow list
    refusing a line whose head it installed. DENY and ASK name the rule
    that spoke.
    """

    RUN = "run"
    NOT_ALLOWED = "not_allowed"
    DENY = "deny"
    ASK = "ask"


@dataclass(frozen=True, slots=True)
class Decision:
    """The role's answer about one line, and what produced it.

    Args:
        outcome (Outcome): which verb spoke.
        rule (CommandRule | None): the rule that spoke; None on RUN and
            on NOT_ALLOWED, which is the allow list rather than a rule.
        matched_path (str | None): the operand a path-scoped rule
            matched, as typed, which the GNU voice prints
            (``rm: letters.txt: <reason>``); None when the rule reaches
            the whole line.
        source (str): where in the document the rule was written, for a
            host reading a verdict: ``top`` or ``mounts./repo``. Empty
            on RUN.
    """

    outcome: Outcome
    rule: CommandRule | None = None
    matched_path: str | None = None
    source: str = ""


def anchor_depth(entry: str) -> int:
    """How specific a path entry is: the number of literal components
    before its first wildcard.

    The one measure the path axis orders by. ``/repo/sealed/*`` is 2,
    ``/repo/*`` and the plain subtree ``/repo`` are 1, and a slashless
    name pattern like ``*.key`` is 0, since it anchors nothing. Every
    pattern the document allows has an answer, so two rules about one
    path are always comparable and nothing is ever guessed.

    Args:
        entry (str): a path entry as written in the document.
    """
    depth = 0
    for part in entry.strip("/").split("/"):
        if not part or is_glob(part):
            break
        depth += 1
    return depth


def rule_depth(rule: CommandRule) -> int:
    """A rule's place on the path axis: the depth of its deepest path
    entry, or 0 when it names none.

    A rule naming no path is not on this axis at all, **wherever it is
    written**, so one in a mount section scores 0 exactly as a top-level
    one does and the two are separated by verb alone. Writing it under
    ``mounts./repo`` scopes it to lines working inside that mount
    (``match_rule`` reads ``rule.mount``); it does not make it more
    specific than a rule about the whole session. That is what keeps
    "denied generally, asked inside one mount" inexpressible for a
    pathless rule, which in practice means an account CLI: such a CLI
    reaches a service and touches no mount, so scoping it to one was
    never meaningful.

    Args:
        rule (CommandRule): an ask or deny rule.
    """
    return max((anchor_depth(entry) for entry in rule.paths), default=0)


# Which verb wins when two rules match at the same anchor depth. Deny
# before ask, and the allow list is not a rule so it never ties.
_VERB_ORDER = {Outcome.DENY: 0, Outcome.ASK: 1}


def _better(current: tuple[int, int] | None, depth: int,
            outcome: Outcome) -> bool:
    """Whether a match beats the best one so far: deeper anchor first,
    then the stronger verb, then the earlier rule (which is why this is
    strict).

    Args:
        current (tuple[int, int] | None): the best (depth, verb) so far.
        depth (int): the candidate's anchor depth.
        outcome (Outcome): the candidate's verb.
    """
    if current is None:
        return True
    best_depth, best_verb = current
    if depth != best_depth:
        return depth > best_depth
    return _VERB_ORDER[outcome] < best_verb


def decide(ctx: CommandContext, rules: AdmissionRules | None) -> Decision:
    """The role's answer about one line: the whole law, in one place.

    Two rules, because a command name and a path are not the same kind
    of thing. A rule naming no path is read by verb, deny before ask,
    wherever it was written. A rule carrying paths is read by anchor
    depth, the deeper entry winning, ties broken by verb. The allow
    list is asked first, since a line no list covers never reaches a
    rule.

    ``PermissionsPolicy`` renders this into the outcome table and
    ``explain`` reports it, so the two cannot disagree about what a
    line would do.

    Args:
        ctx (CommandContext): the classified command.
        rules (AdmissionRules | None): the session's admission rules.
    """
    if rules is None:
        return Decision(Outcome.RUN)
    if not line_allowed(ctx, rules):
        return Decision(Outcome.NOT_ALLOWED, source="commands.allow")
    best: tuple[int, int] | None = None
    chosen = Decision(Outcome.RUN)
    for outcome, written in ((Outcome.DENY, rules.deny), (Outcome.ASK,
                                                          rules.ask)):
        for rule in written:
            hit = match_rule(rule, rule_scope(rule), ctx)
            if hit is None:
                continue
            depth = rule_depth(rule)
            if not _better(best, depth, outcome):
                continue
            best = (depth, _VERB_ORDER[outcome])
            chosen = Decision(outcome=outcome,
                              rule=rule,
                              matched_path=hit.operand,
                              source=source_of(rule))
    return chosen


def source_of(rule: CommandRule) -> str:
    """Where in the document a rule was written, as a host reads it:
    the mount section it belongs to, or the top level.

    Args:
        rule (CommandRule): the rule that spoke.
    """
    return f"mounts.{rule.mount}" if rule.mount else "top"
