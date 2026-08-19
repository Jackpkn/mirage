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
from mirage.policy.match import line_allowed, op_hit, rule_hit
from mirage.policy.types import (Action, Ask, CommandContext, CommandRule,
                                 Deny, DenyScope, OpsContext,
                                 SessionCommandsQuery)
from mirage.types import HiddenPaths
from mirage.utils.hidden import classify_paths


class PermissionsPolicy(Policy):
    """The permissions document's ``commands`` blocks, enforced.

    Seeded by the workspace after ``MountRootPolicy`` (POSIX messages
    still win) and before user policies, so a document rule speaks
    before a coded one when both match. It reads the session's
    compiled tiers through the narrow ``SessionCommandsQuery`` by the
    session id the door put in the context, never through ambient
    state: an explicit fact survives the thread hop that drops a
    contextvar. Verdicts render through the one outcome table
    (``render_deny``), so an agent cannot tell a document deny from a
    coded one.

    ``pre_command``: the allow arm (a line no allow list of a tier
    covers is refused whole, though its head was visible), then the
    deny arm (the first matching rule in tier order: whole-command or
    operand-scoped by whether the rule names paths), then the ask arm
    (the first matching ask rule in tier order raises an Ask, which
    the approval door answers from the session's grants or the host).
    ``pre_ops``: the pure path rules of every tier, so FUSE,
    programmatic ops and the warm cache cannot bypass a path a
    document protects; there is no ask at the op door.

    Args:
        sessions (SessionCommandsQuery): the session manager, answering
            ``commands_of(session_id)``.
    """

    def __init__(self, sessions: SessionCommandsQuery) -> None:
        self._sessions = sessions
        self._scopes: dict[CommandRule, HiddenPaths | None] = {}

    def _scope(self, rule: CommandRule) -> HiddenPaths | None:
        """A rule's paths, classified once and remembered.

        Args:
            rule (CommandRule): the rule.
        """
        try:
            return self._scopes[rule]
        except KeyError:
            scope = classify_paths(rule.paths)
            self._scopes[rule] = scope
            return scope

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        layers = self._sessions.commands_of(ctx.session_id)
        if not layers:
            return None
        if not line_allowed(ctx, layers):
            program = " ".join(ctx.program or (ctx.command, ))
            return Deny(f"{program} is not allowed")
        for spec in layers:
            for rule in spec.deny:
                hit = rule_hit(rule, self._scope(rule), ctx)
                if hit is None:
                    continue
                if hit.operand is None:
                    return Deny(rule.reason)
                return Deny(f"{hit.operand}: {rule.reason}", DenyScope.OPERAND)
        for spec in layers:
            for rule in spec.ask:
                if rule_hit(rule, self._scope(rule), ctx) is not None:
                    return Ask(rule.reason, rule)
        return None

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        for spec in self._sessions.commands_of(ctx.session_id):
            for rule in spec.deny:
                if op_hit(rule, self._scope(rule), ctx):
                    return Deny(rule.reason)
        return None
