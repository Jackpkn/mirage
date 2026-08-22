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
from mirage.policy.builtin import (DEFAULT_COMMAND_LIMITS, FALLBACK_LIMIT,
                                   MountRootPolicy, OutputCapPolicy,
                                   PermissionsPolicy, resolve_across_mounts,
                                   resolve_limit, resolve_producer)
from mirage.policy.constants import (DEFAULT_ASK_REASON, DEFAULT_DENY_REASON,
                                     POLICY_DENIED_EXIT)
from mirage.policy.decisions import (AskHandler, Decisions, ask_rule, covers,
                                     decision_id)
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.policies import (Policies, post_execute_gate, post_ops_gate,
                                    pre_ops_gate, pre_session_gate,
                                    render_deny, render_pending)
from mirage.policy.profile import (CommandsBlock, CompiledProfile,
                                   MountCommandsBlock, PathsBlock,
                                   ProfileMount, SessionProfile, VarsBlock)

from mirage.policy.types import (  # isort: skip
    VALIDITY, Action, Ask, CommandContext, CommandRule, AdmissionRules,
    Decision, Deny, DenyScope, ExecuteResultContext, Explanation, Limit,
    MountRootQuery, OpsContext, OpsResultContext, Pending, Scope,
    SessionCommandsQuery, SessionContext, SessionDecisionsQuery)

__all__ = [
    "Action",
    "AdmissionRules",
    "Ask",
    "ask_rule",
    "AskHandler",
    "CommandContext",
    "CommandRule",
    "CommandsBlock",
    "CompiledProfile",
    "covers",
    "Decision",
    "decision_id",
    "Decisions",
    "DEFAULT_ASK_REASON",
    "DEFAULT_COMMAND_LIMITS",
    "DEFAULT_DENY_REASON",
    "Deny",
    "DenyScope",
    "ExecuteResultContext",
    "Explanation",
    "FALLBACK_LIMIT",
    "Limit",
    "MountCommandsBlock",
    "MountRootPolicy",
    "MountRootQuery",
    "OpsContext",
    "OpsResultContext",
    "OutputCapPolicy",
    "PathsBlock",
    "Pending",
    "PermissionsPolicy",
    "Policies",
    "Policy",
    "POLICY_DENIED_EXIT",
    "PolicyDenied",
    "PolicyError",
    "post_execute_gate",
    "post_ops_gate",
    "pre_ops_gate",
    "pre_session_gate",
    "ProfileMount",
    "render_deny",
    "render_pending",
    "resolve_across_mounts",
    "resolve_limit",
    "resolve_producer",
    "Scope",
    "SessionCommandsQuery",
    "SessionContext",
    "SessionDecisionsQuery",
    "SessionProfile",
    "VALIDITY",
    "VarsBlock",
]
