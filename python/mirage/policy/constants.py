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

# A whole-command refusal exits as bash does for a command it found but
# may not run.
POLICY_DENIED_EXIT = 126

# The reason a bare command pattern under ``commands.deny`` carries, and
# the one a bare pattern under ``commands.ask`` carries.
DEFAULT_DENY_REASON = "denied by policy"
DEFAULT_ASK_REASON = "no standing approval"

# The one pattern token that matches any one line token; trailing, it
# matches whatever follows, which a prefix already does.
WILDCARD = "*"

# The approval decisions that answer one retry of the exact line (the
# words and cwd of the request) and are consumed by it; ``allow_session``
# is the one that covers the rule and stays.
EXACT_LINE_DECISIONS = frozenset({"allow_once", "deny"})

# Ops that act on a whole subtree at once, so a pure path rule refuses
# them on the directory that holds its scope or on any ancestor: moving
# or removing ``/x`` takes ``/x/locked/*`` along. ``rename`` is the
# dispatcher's; ``rmdir`` removes the scope's own directory; ``rm_r`` is
# the command tier's recursive remove.
SUBTREE_OPS = frozenset({"rename", "rmdir", "rm_r"})

# Commands whose operand is a whole subtree they move or remove, so a
# path rule judges the operand the way it judges a SUBTREE_OPS op: the
# directory holding the scope, or any ancestor of it, is the scope.
# Only the destroyers: a reader given an ancestor (``grep -r``, ``du``,
# ``tar``) is the command tier's I/O to refuse file by file, not a line
# to refuse whole.
SUBTREE_COMMANDS = frozenset({"rm", "rmdir", "mv"})
