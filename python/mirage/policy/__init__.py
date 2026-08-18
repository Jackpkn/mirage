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
                                   resolve_across_mounts, resolve_limit,
                                   resolve_producer)
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.policies import (Policies, post_execute_gate, post_ops_gate,
                                    pre_ops_gate, pre_session_gate)
from mirage.policy.types import (DEFAULT_DENY_REASON, VALIDITY, Action,
                                 CommandContext, CommandRule, Deny,
                                 ExecuteResultContext, Limit, MountRootQuery,
                                 OpsContext, OpsResultContext, SessionContext)

__all__ = [
    "Action",
    "CommandContext",
    "CommandRule",
    "DEFAULT_COMMAND_LIMITS",
    "DEFAULT_DENY_REASON",
    "Deny",
    "ExecuteResultContext",
    "FALLBACK_LIMIT",
    "Limit",
    "MountRootPolicy",
    "MountRootQuery",
    "OpsContext",
    "OpsResultContext",
    "OutputCapPolicy",
    "Policies",
    "Policy",
    "PolicyDenied",
    "PolicyError",
    "SessionContext",
    "VALIDITY",
    "post_execute_gate",
    "post_ops_gate",
    "pre_ops_gate",
    "pre_session_gate",
    "resolve_across_mounts",
    "resolve_producer",
    "resolve_limit",
]
