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

from mirage.policy.match.allow import head_visible, line_allowed, line_tokens
from mirage.policy.types import CommandContext, CommandRule, CommandsSpec


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _ctx(command: str,
         argv: tuple[str, ...] = (),
         tokens: tuple[str, ...] = (),
         tool: bool = True) -> CommandContext:
    return CommandContext(command=command,
                          paths=(),
                          argv=argv,
                          cwd="/",
                          registry=_Registry(),
                          tokens=tokens,
                          tool=tool)


def test_head_visible_needs_a_pattern_in_every_tier_with_a_list():
    layers = (CommandsSpec(allow=("ls", "git")),
              CommandsSpec(allow=("ls", "cat", "git log")))
    # A name must start a pattern of every tier that has a list.
    assert head_visible("ls", layers)
    assert head_visible("git", layers)
    assert not head_visible("cat", layers)
    assert not head_visible("rm", layers)
    # A tier without a list hides nothing; no tiers hide nothing.
    assert head_visible("rm", (CommandsSpec(deny=(CommandRule("x"), )), ))
    assert head_visible("rm", ())


def test_line_allowed_intersects_the_tiers_and_skips_non_tools():
    layers = (CommandsSpec(allow=("ls", "git")),
              CommandsSpec(allow=("ls", "git log", "git status")))
    assert line_allowed(_ctx("ls", ("-la", ), tokens=("ls", "-la")), layers)
    assert line_allowed(_ctx("git", tokens=("git", "log", "-1")), layers)
    # The head is visible (some git line is allowed) but this line is
    # covered by no pattern of the second tier.
    assert not line_allowed(_ctx("git", tokens=("git", "push")), layers)
    # A word that is not a tool is never refused by an allow list.
    assert line_allowed(_ctx("cd", tokens=("cd", "/x"), tool=False), layers)
    # A context built without the door's tokens reads the raw argv.
    raw = _ctx("git", ("push", ))
    assert line_tokens(raw) == ("git", "push")
    assert not line_allowed(raw, layers)
