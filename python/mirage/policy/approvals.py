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

from mirage.policy.approver import Approver, RecordApprover, request_id
from mirage.policy.constants import EXACT_LINE_DECISIONS
from mirage.policy.types import (ApprovalDecision, ApprovalRequest, Ask,
                                 CommandContext, CommandRule, Deny, Grant,
                                 GrantScope, Pending, SessionGrantsQuery)


def ask_rule(ctx: CommandContext, ask: Ask) -> CommandRule:
    """The rule an Ask is keyed on: the document's, or for a coded Ask
    one synthesized over the program that asked, so a session grant
    reads "stop asking me about this program".

    Args:
        ctx (CommandContext): the asked line.
        ask (Ask): the policy's answer.
    """
    if ask.rule is not None:
        return ask.rule
    program = " ".join(ctx.program or (ctx.command, ))
    return CommandRule(reason=ask.reason, commands=(program, ))


class Approvals:
    """The workspace's approval door: turns an Ask into run, refuse or
    pending, and is the host's handle on what is pending.

    Reached by the executor through the mount registry like the policy
    chain, and by the host as ``ws.approvals``. Grants are consulted
    only after the policy chain returned an Ask, which is after every
    Deny had its say, so a grant never re-opens a deny. They are read
    and written through the session manager by id, so a line running
    in a fork (``execute(cwd=)``, a background job) consumes and earns
    the same grants as the session it forked from.

    Args:
        sessions (SessionGrantsQuery | None): where grants live: the
            session manager, or None to hold them in memory (a bare
            policy chain outside a workspace).
        approver (Approver | None): how the host answers; None installs
            the non-blocking ``RecordApprover``.
    """

    def __init__(self,
                 sessions: SessionGrantsQuery | None = None,
                 approver: Approver | None = None) -> None:
        self._sessions = sessions
        self._approver: Approver = (approver if approver is not None else
                                    RecordApprover())
        self._memory: dict[str, tuple[Grant, ...]] = {}

    @property
    def approver(self) -> Approver:
        return self._approver

    def list(self) -> tuple[ApprovalRequest, ...]:
        """The requests waiting for the host, oldest first. Only the
        recording approver leaves any: a blocking one answers inside
        the line."""
        recorder = self._approver
        if isinstance(recorder, RecordApprover):
            return recorder.pending()
        return ()

    async def grant(self,
                    approval_id: str,
                    scope: GrantScope = "once") -> None:
        """Answer a pending request yes: the retry of the exact line
        passes once, or every line the rule covers passes for the rest
        of the session.

        Args:
            approval_id (str): the id the agent was told to quote.
            scope (GrantScope): ``once`` or ``session``.

        Raises:
            KeyError: no pending request has that id.
        """
        request = self._take(approval_id)
        decision: ApprovalDecision = ("allow_once"
                                      if scope == "once" else "allow_session")
        self._add(
            request.session_id,
            Grant(decision, request.rule, self._words(request), request.cwd))
        await self._flush()

    async def deny(self, approval_id: str) -> None:
        """Answer a pending request no: the retry of the exact line is
        refused in the deny voice, once; asking again raises a new
        request.

        Args:
            approval_id (str): the id the agent was told to quote.

        Raises:
            KeyError: no pending request has that id.
        """
        request = self._take(approval_id)
        self._add(
            request.session_id,
            Grant("deny", request.rule, self._words(request), request.cwd))
        await self._flush()

    async def resolve(self, ctx: CommandContext,
                      ask: Ask) -> Deny | Pending | None:
        """The executor's branch for an Ask: held grants answer it, else
        the approver is asked now.

        Every rule the ask names has to be answered, because each won a
        subject of its own and a nod covers the subject it was given
        for. They are asked one at a time, the retry of the line raising
        the next, and an exact-line grant is only spent once the whole
        line is answered: spending one while another is still pending
        would make the first question come back on every retry.

        Args:
            ctx (CommandContext): the asked line.
            ask (Ask): the chain's answer.

        Returns:
            None to run the line, a Deny to refuse it, a Pending when
            the host has not decided.
        """
        rules = ask.rules or (ask_rule(ctx, ask), )
        argv = (ctx.command, *ctx.argv)
        held = self._grants(ctx.session_id)
        answers = [(rule, self._answer(held, rule, argv, ctx.cwd))
                   for rule in rules]
        spent = tuple(g for _rule, g in answers
                      if g is not None and g.decision in EXACT_LINE_DECISIONS)
        refused = next(
            (rule
             for rule, g in answers if g is not None and g.decision == "deny"),
            None)
        if refused is not None:
            self._spend(ctx.session_id, held, spent)
            return Deny(refused.reason)
        for rule, grant in answers:
            if grant is not None:
                continue
            verdict = await self._ask_host(ctx, rule, argv)
            if verdict is not None:
                return verdict
        self._spend(ctx.session_id, held, spent)
        return None

    async def _ask_host(self, ctx: CommandContext, rule: CommandRule,
                        argv: tuple[str, ...]) -> Deny | Pending | None:
        """Put one rule of a line to the approver, None when it said yes.

        Args:
            ctx (CommandContext): the asked line.
            rule (CommandRule): the rule with no grant behind it.
            argv (tuple[str, ...]): the line's words, name first.
        """
        request = ApprovalRequest(id=request_id(ctx.session_id, ctx.cwd, argv),
                                  session_id=ctx.session_id,
                                  agent_id=ctx.agent_id,
                                  command=ctx.command,
                                  argv=tuple(ctx.argv),
                                  cwd=ctx.cwd,
                                  paths=tuple(p.virtual for p in ctx.paths),
                                  reason=rule.reason,
                                  rule=rule)
        decision = await self._approver.approve(request)
        if decision is None:
            return Pending(request.id, rule.reason)
        if decision == "deny":
            return Deny(rule.reason)
        if decision == "allow_session":
            self._add(ctx.session_id,
                      Grant("allow_session", rule, argv, ctx.cwd))
        return None

    @staticmethod
    def _answer(held: tuple[Grant, ...], rule: CommandRule,
                argv: tuple[str, ...], cwd: str) -> Grant | None:
        """The grant standing behind one rule of a line, None when the
        host has not answered it.

        An exact-line grant answers the rule it was asked under, like a
        session grant: one that outlives a rule change (a persisted
        store reopened under an edited profile) must not answer the new
        rule's ask, and a stale denial must not speak in its voice.

        Args:
            held (tuple[Grant, ...]): the session's grants.
            rule (CommandRule): the rule to answer.
            argv (tuple[str, ...]): the line's words, name first.
            cwd (str): the session working directory.
        """
        for grant in held:
            if (grant.decision in EXACT_LINE_DECISIONS and grant.argv == argv
                    and grant.cwd == cwd and grant.rule == rule):
                return grant
        for grant in held:
            if grant.decision == "allow_session" and grant.rule == rule:
                return grant
        return None

    def _spend(self, session_id: str, held: tuple[Grant, ...],
               spent: tuple[Grant, ...]) -> None:
        """Drop the exact-line grants this line just used up.

        Args:
            session_id (str): the session running the line.
            held (tuple[Grant, ...]): the session's grants as read.
            spent (tuple[Grant, ...]): the ones the line consumed.
        """
        if not spent:
            return
        self._set(session_id,
                  tuple(g for g in held if not any(g is s for s in spent)))

    def _take(self, approval_id: str) -> ApprovalRequest:
        recorder = self._approver
        if not isinstance(recorder, RecordApprover):
            raise KeyError(approval_id)
        return recorder.take(approval_id)

    @staticmethod
    def _words(request: ApprovalRequest) -> tuple[str, ...]:
        return (request.command, *request.argv)

    def _grants(self, session_id: str) -> tuple[Grant, ...]:
        if self._sessions is not None:
            return self._sessions.grants_of(session_id)
        return self._memory.get(session_id, ())

    def _set(self, session_id: str, grants: tuple[Grant, ...]) -> None:
        if self._sessions is not None:
            self._sessions.set_grants(session_id, grants)
        else:
            self._memory[session_id] = grants

    def _add(self, session_id: str, grant: Grant) -> None:
        self._set(session_id, (*self._grants(session_id), grant))

    async def _flush(self) -> None:
        if self._sessions is not None:
            await self._sessions.flush()
