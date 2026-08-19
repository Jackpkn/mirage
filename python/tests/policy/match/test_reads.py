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

from mirage.policy.match import has_rules, reads_args
from mirage.policy.types import CommandRule, CommandsSpec


def test_has_rules_is_any_tier_stating_anything():
    assert not has_rules(())
    assert not has_rules((CommandsSpec(), CommandsSpec()))
    assert has_rules((CommandsSpec(allow=()), ))
    assert has_rules((CommandsSpec(ask=(CommandRule("r"), )), ))
    assert has_rules((CommandsSpec(), CommandsSpec(deny=(CommandRule("r"), ))))


def test_reads_args_only_for_a_rule_that_reads_past_the_name():
    layers = (
        CommandsSpec(allow=("cat", "git status", "*")),
        CommandsSpec(deny=(
            CommandRule("no rm", commands=("rm", )),
            CommandRule("sealed", commands=("cat", ), paths=("/secret*", )),
            CommandRule("no force", commands=("git push -f", )),
            CommandRule("repo", commands=("ls", ), mount="/repo"))),
        CommandsSpec(ask=(CommandRule("frozen", paths=("/locked/*", )), )),
    )
    # A token after the name, a path or a mount reads the arguments.
    assert reads_args(layers, "git")
    assert reads_args(layers, "cat")
    assert reads_args(layers, "ls")
    # The command-less frozen rule reads every command's paths.
    assert reads_args(layers, "echo")
    # With no such rule for it, a command's arguments are unread: the
    # wildcard allow and the bare `rm` deny decide on the name alone.
    assert not reads_args(
        (CommandsSpec(allow=("*", "rm")),
         CommandsSpec(deny=(CommandRule("no rm", commands=("rm", )), ))), "rm")
    assert not reads_args((), "rm")
