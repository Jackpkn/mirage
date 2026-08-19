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

from mirage.policy.types import CommandRule, CommandsSpec, Grant
from mirage.workspace.session.serialize import (commands_from_dict,
                                                commands_to_dict,
                                                grant_from_dict, grant_to_dict,
                                                rule_from_dict, rule_to_dict)


def test_rule_round_trips_and_writes_mount_only_when_set():
    bare = CommandRule(reason="no", commands=("rm", ))
    data = rule_to_dict(bare)
    assert data == {"reason": "no", "commands": ["rm"], "paths": []}
    assert rule_from_dict(data) == bare
    scoped = CommandRule(reason="ro",
                         commands=("git push", ),
                         paths=("/repo/*", ),
                         mount="/repo")
    assert rule_to_dict(scoped)["mount"] == "/repo"
    assert rule_from_dict(rule_to_dict(scoped)) == scoped
    # A record written before a field existed reads with the default.
    assert rule_from_dict({"reason": "x"}) == CommandRule(reason="x")


def test_commands_round_trips_and_keeps_an_absent_allow_list():
    spec = CommandsSpec(allow=("ls", "git log"),
                        ask=(CommandRule(reason="sign-off",
                                         commands=("git push", )), ),
                        deny=(CommandRule(reason="no", commands=("rm", )), ))
    assert commands_from_dict(commands_to_dict(spec)) == spec
    unlisted = CommandsSpec(deny=(CommandRule(reason="x"), ))
    data = commands_to_dict(unlisted)
    assert data["allow"] is None
    assert commands_from_dict(data) == unlisted
    assert commands_from_dict({}) == CommandsSpec()


def test_grant_round_trips_with_defaults():
    rule = CommandRule(reason="sign-off", commands=("git push", ))
    grant = Grant("allow_session", rule, ("git", "push"), "/repo")
    assert grant_from_dict(grant_to_dict(grant)) == grant
    read = grant_from_dict({"decision": "deny", "rule": rule_to_dict(rule)})
    assert read == Grant("deny", rule, (), "/")
