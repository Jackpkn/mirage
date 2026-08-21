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

from mirage.policy.base import Policy
from mirage.policy.match import Outcome, decide, match_op, rule_scope
from mirage.policy.types import (Action, Ask, CommandContext, Deny, DenyScope,
                                 OpsContext, SessionCommandsQuery)


class PermissionsPolicy(Policy):
    """The role's ``commands`` rules, enforced.

    Seeded by the workspace after ``MountRootPolicy`` (POSIX messages
    still win) and before user policies, so a document rule speaks
    before a coded one when both match. It reads the session's
    compiled rules through the narrow ``SessionCommandsQuery`` by the
    session id the door put in the context, never through ambient
    state: an explicit fact survives the thread hop that drops a
    contextvar. Verdicts render through the one outcome table
    (``render_deny``), so an agent cannot tell a document deny from a
    coded one.

    ``pre_command`` renders one ``decide`` call, which is where the
    law lives: the allow list first (a line it does not cover is
    refused whole, though its head was visible), then the winning rule,
    refused whole or per operand by whether it names paths, or taken to
    the approval door when it asks. ``pre_ops`` walks the deny rules
    that are pure paths, so FUSE, programmatic ops and the warm cache
    cannot bypass a path the role protects; there is no ask at the op
    door, which cannot wait on a host.

    Args:
        sessions (SessionCommandsQuery): the session manager, answering
            ``commands_of(session_id)``.
    """

    def __init__(self, sessions: SessionCommandsQuery) -> None:
        self._sessions = sessions

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        verdict = decide(ctx, self._sessions.commands_of(ctx.session_id))
        if verdict.outcome is Outcome.NOT_ALLOWED:
            program = " ".join(ctx.program or (ctx.command, ))
            return Deny(f"{program} is not allowed")
        rule = verdict.rule
        if rule is None:
            return None
        if verdict.outcome is Outcome.ASK:
            return Ask(rule.reason, rule, verdict.asks)
        if verdict.matched_path is None:
            return Deny(rule.reason)
        return Deny(f"{verdict.matched_path}: {rule.reason}",
                    DenyScope.OPERAND)

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        rules = self._sessions.commands_of(ctx.session_id)
        if rules is None:
            return None
        for rule in rules.deny:
            if match_op(rule, rule_scope(rule), ctx):
                return Deny(rule.reason)
        return None
