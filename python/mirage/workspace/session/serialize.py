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

from collections.abc import Mapping
from typing import Any

from mirage.policy.types import CommandRule, CommandsSpec, Grant


def rule_to_dict(rule: CommandRule) -> dict[str, Any]:
    """One admission rule as the session record stores it.

    Args:
        rule (CommandRule): the rule.
    """
    data: dict[str, Any] = {
        "reason": rule.reason,
        "commands": list(rule.commands),
        "paths": list(rule.paths),
    }
    if rule.mount:
        data["mount"] = rule.mount
    return data


def rule_from_dict(data: Mapping[str, Any]) -> CommandRule:
    """One admission rule read back from a session record.

    Args:
        data (Mapping[str, Any]): what ``rule_to_dict`` wrote.
    """
    return CommandRule(reason=data["reason"],
                       commands=tuple(data.get("commands", ())),
                       paths=tuple(data.get("paths", ())),
                       mount=data.get("mount", ""))


def commands_to_dict(spec: CommandsSpec) -> dict[str, Any]:
    """A compiled command tier as the session record stores it.

    Args:
        spec (CommandsSpec): the tier.
    """
    return {
        "allow": list(spec.allow) if spec.allow is not None else None,
        "ask": [rule_to_dict(r) for r in spec.ask],
        "deny": [rule_to_dict(r) for r in spec.deny],
    }


def commands_from_dict(data: Mapping[str, Any]) -> CommandsSpec:
    """A compiled command tier read back from a session record.

    Args:
        data (Mapping[str, Any]): what ``commands_to_dict`` wrote.
    """
    allow = data.get("allow")
    return CommandsSpec(
        allow=tuple(allow) if allow is not None else None,
        ask=tuple(rule_from_dict(r) for r in data.get("ask", ())),
        deny=tuple(rule_from_dict(r) for r in data.get("deny", ())))


def grant_to_dict(grant: Grant) -> dict[str, Any]:
    """A host grant as the session record stores it.

    Args:
        grant (Grant): the grant.
    """
    return {
        "decision": grant.decision,
        "rule": rule_to_dict(grant.rule),
        "argv": list(grant.argv),
        "cwd": grant.cwd,
    }


def grant_from_dict(data: Mapping[str, Any]) -> Grant:
    """A host grant read back from a session record.

    Args:
        data (Mapping[str, Any]): what ``grant_to_dict`` wrote.
    """
    return Grant(decision=data["decision"],
                 rule=rule_from_dict(data["rule"]),
                 argv=tuple(data.get("argv", ())),
                 cwd=data.get("cwd", "/"))
