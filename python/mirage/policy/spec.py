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
from mirage.policy.types import (Action, CommandContext, CommandRule, Deny,
                                 OpsContext)
from mirage.utils.hidden import classify_paths, path_hidden


class SpecPolicy(Policy):
    """A CommandRule compiled to a policy.

    Internal: the workspace builds one per rule of the document's
    ``commands.deny``; nothing outside the package constructs it. The
    rule's paths compile through the same classifier as ``paths.hide``
    and match through the same matcher, so a deny scope and a hide
    read one grammar.

    Args:
        rule (CommandRule): the declarative rule.
    """

    def __init__(self, rule: CommandRule) -> None:
        self.rule = rule
        self._scope = classify_paths(rule.paths)

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        rule = self.rule
        if rule.commands and ctx.command not in rule.commands:
            return None
        if self._scope is None:
            return Deny(f"{ctx.command}: {rule.reason}\n")
        for p in ctx.paths:
            if path_hidden(self._scope, p.virtual):
                display = p.raw_path or p.virtual
                return Deny(f"{ctx.command}: {display}: {rule.reason}\n")
        return None

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        # The op-layer twin: pure path protection (no command scope)
        # also holds at the op doors, so FUSE, programmatic ops, and
        # the warm cache cannot bypass it. Command-scoped rules stay
        # command-layer: an op does not know which command issued it.
        rule = self.rule
        if rule.commands or self._scope is None:
            return None
        if path_hidden(self._scope, ctx.path.virtual):
            return Deny(f"{rule.reason}\n")
        return None
