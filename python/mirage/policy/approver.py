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

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from typing import Protocol

from mirage.policy.types import ApprovalDecision, ApprovalRequest


class Approver(Protocol):
    """How the host answers an asked line.

    Called by the approval door with the request the agent's line
    raised. ``None`` means the host has not decided: the door refuses
    the line for now (126, ``requires approval``) and the agent learns
    the answer by retrying. Any other answer applies at once.
    """

    async def approve(self,
                      request: ApprovalRequest) -> ApprovalDecision | None:
        """Answer one request.

        Args:
            request (ApprovalRequest): the asked line.
        """
        ...


def request_id(session_id: str, cwd: str, argv: tuple[str, ...]) -> str:
    """The id of an approval request: a digest of what was asked, so a
    retry of the same line in the same session asks the same question
    and the host answers it once.

    Args:
        session_id (str): the session running the line.
        cwd (str): its working directory.
        argv (tuple[str, ...]): the line as expanded, command name
            first.
    """
    digest = hashlib.sha1()
    for part in (session_id, cwd, *argv):
        digest.update(part.encode())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


class RecordApprover:
    """The default approver: records the request and answers pending.

    Non-blocking, for a host that reads ``ws.approvals`` later (a
    REST poll, a CLI listing) rather than one that can answer inside
    the line. The pending ledger is keyed by request id, so a retry
    of the same line adds nothing and the agent keeps quoting one id.
    """

    def __init__(self) -> None:
        self._pending: dict[str, ApprovalRequest] = {}

    async def approve(self,
                      request: ApprovalRequest) -> ApprovalDecision | None:
        self._pending.setdefault(request.id, request)
        return None

    def pending(self) -> tuple[ApprovalRequest, ...]:
        """The requests nobody has answered, oldest first."""
        return tuple(self._pending.values())

    def take(self, approval_id: str) -> ApprovalRequest:
        """Remove and return one pending request.

        Args:
            approval_id (str): the request id.

        Raises:
            KeyError: no pending request has that id.
        """
        return self._pending.pop(approval_id)


class CallbackApprover:
    """An approver that waits on the host: the line blocks the way a
    tool call blocks on a permission prompt.

    Args:
        fn (Callable[[ApprovalRequest], Awaitable[ApprovalDecision]]):
            the host coroutine.
        timeout (float | None): seconds to wait before the request
            counts as denied; None waits.
    """

    def __init__(self,
                 fn: Callable[[ApprovalRequest], Awaitable[ApprovalDecision]],
                 timeout: float | None = None) -> None:
        self._fn = fn
        self._timeout = timeout

    async def approve(self,
                      request: ApprovalRequest) -> ApprovalDecision | None:
        try:
            return await asyncio.wait_for(self._fn(request), self._timeout)
        except TimeoutError:
            return "deny"
