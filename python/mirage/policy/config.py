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

from dataclasses import dataclass

from mirage.policy.types import CommandRule, Outcome


@dataclass(frozen=True, slots=True)
class Decision:
    """The role's answer about one line, and what produced it.

    Args:
        outcome (Outcome): which verb spoke.
        rule (CommandRule | None): the rule that spoke; None on RUN and
            on NOT_ALLOWED, which is the allow list rather than a rule.
        matched_path (str | None): the operand a path-scoped rule
            matched, as typed, which the GNU voice prints
            (``rm: letters.txt: <reason>``); None when the rule reaches
            the whole line.
        source (str): where in the document the rule was written, for a
            host reading a verdict: ``top`` or ``mounts./repo``. Empty
            on RUN.
    """

    outcome: Outcome
    rule: CommandRule | None = None
    matched_path: str | None = None
    source: str = ""
