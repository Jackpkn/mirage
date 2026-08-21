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
from mirage.policy.match.rule import (ASK_SECOND, DENY_FIRST, better_match,
                                      match_rule, rule_scope)
from mirage.policy.types import AdmissionRules, CommandContext, CommandRule


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


# Which verb wins when two rules match at the same anchor depth. Deny
# before ask, and the allow list is not a rule so it never ties. The
# ordering itself lives in ``match.rule`` because the entry gate reads
# by it too.
_VERB_ORDER = {Outcome.DENY: DENY_FIRST, Outcome.ASK: ASK_SECOND}


def decide(ctx: CommandContext, rules: AdmissionRules | None) -> Decision:
    """The role's answer about one line: the whole law, in one place.

    Two rules, because a command name and a path are not the same kind
    of thing. A rule naming no path is read by verb, deny before ask,
    wherever it was written: it is off the path axis entirely, so one
    in a mount section scores 0 exactly as a top-level one does.
    Writing it under ``mounts./repo`` scopes it to lines working inside
    that mount (``match_rule`` reads ``rule.mount``); it does not make
    it more specific than a rule about the whole session. That is what
    keeps "denied generally, asked inside one mount" inexpressible for
    a pathless rule, which in practice means an account CLI: such a CLI
    reaches a service and touches no mount, so scoping it to one was
    never meaningful.

    A rule carrying paths is read by anchor depth, the deeper entry
    winning, ties broken by verb. The depth is the matched entry's, not
    the rule's deepest, so an entry that says nothing about this
    operand cannot lend it specificity. The allow list is asked first,
    since a line no list covers never reaches a rule.

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
            if not better_match(best, hit.depth, _VERB_ORDER[outcome]):
                continue
            best = (hit.depth, _VERB_ORDER[outcome])
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
