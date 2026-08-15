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

from mirage.accessor.base import Accessor
from mirage.core.github.tree_entry import TreeEntry


class GitHubAccessor(Accessor):

    def __init__(self,
                 config,
                 owner,
                 repo,
                 ref,
                 default_branch,
                 tree: dict[str, TreeEntry] | None = None,
                 truncated=False):
        self.config = config
        self.owner = owner
        self.repo = repo
        self.ref = ref
        self.default_branch = default_branch
        # The recursive git tree, keyed repo-relative with no leading
        # slash, which is this mount's whole listing. find, du and grep's
        # scope counter read it straight, the way TypeScript's always
        # have: repo-relative path logic belongs on a git tree, not on an
        # index whose keys are the mount's business. Reseated by every
        # refill, so it is as fresh as the last one.
        self.tree: dict[str, TreeEntry] = tree if tree is not None else {}
        self.truncated = truncated
