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
from mirage.policy.match.pattern import (intersect_patterns, pattern_matches,
                                         pattern_names, split_pattern)
from mirage.policy.match.reads import has_rules, reads_args, scopes_paths
from mirage.policy.match.rule import RuleMatch, match_op, match_rule

__all__ = [
    "RuleMatch",
    "has_rules",
    "head_visible",
    "intersect_patterns",
    "line_allowed",
    "line_tokens",
    "match_op",
    "match_rule",
    "pattern_matches",
    "pattern_names",
    "reads_args",
    "scopes_paths",
    "split_pattern",
]
