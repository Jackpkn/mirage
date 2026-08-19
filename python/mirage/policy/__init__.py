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

from mirage.policy.approvals import Approvals, ask_rule
from mirage.policy.approver import (Approver, CallbackApprover, RecordApprover,
                                    request_id)
from mirage.policy.base import Policy
from mirage.policy.builtin import (DEFAULT_COMMAND_LIMITS, FALLBACK_LIMIT,
                                   MountRootPolicy, OutputCapPolicy,
                                   PermissionsPolicy, resolve_across_mounts,
                                   resolve_limit, resolve_producer)
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.policies import (POLICY_DENIED_EXIT, Policies,
                                    post_execute_gate, post_ops_gate,
                                    pre_ops_gate, pre_session_gate,
                                    render_deny, render_pending)

from mirage.policy.types import (  # isort: skip
    DEFAULT_ASK_REASON, DEFAULT_DENY_REASON, VALIDITY, Action,
    ApprovalDecision, ApprovalRequest, Ask, CommandContext, CommandRule,
    CommandsSpec, Deny, DenyScope, ExecuteResultContext, Grant, GrantScope,
    Limit, MountRootQuery, OpsContext, OpsResultContext, Pending,
    SessionCommandsQuery, SessionContext, SessionGrantsQuery)

__all__ = [
    "Action",
    "ApprovalDecision",
    "ApprovalRequest",
    "Approvals",
    "Approver",
    "Ask",
    "CallbackApprover",
    "CommandContext",
    "CommandRule",
    "CommandsSpec",
    "DEFAULT_ASK_REASON",
    "DEFAULT_COMMAND_LIMITS",
    "DEFAULT_DENY_REASON",
    "Deny",
    "DenyScope",
    "ExecuteResultContext",
    "FALLBACK_LIMIT",
    "Grant",
    "GrantScope",
    "Limit",
    "MountRootPolicy",
    "MountRootQuery",
    "OpsContext",
    "OpsResultContext",
    "OutputCapPolicy",
    "POLICY_DENIED_EXIT",
    "Pending",
    "PermissionsPolicy",
    "Policies",
    "Policy",
    "PolicyDenied",
    "PolicyError",
    "RecordApprover",
    "SessionCommandsQuery",
    "SessionContext",
    "SessionGrantsQuery",
    "VALIDITY",
    "ask_rule",
    "post_execute_gate",
    "post_ops_gate",
    "pre_ops_gate",
    "pre_session_gate",
    "render_deny",
    "render_pending",
    "request_id",
    "resolve_across_mounts",
    "resolve_producer",
    "resolve_limit",
]
