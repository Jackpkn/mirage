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

from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.hf_hub.io import IO as _IO

# The three git-repo resources. `hf_buckets` is deliberately absent: it is a
# different Hugging Face product (Xet-backed mutable object storage, no
# commits and no revisions) and keeps its own OpenDAL-backed commands.
#
# Registration is per concrete resource rather than under one shared
# "hf_hub" name because that name is not mountable: nothing builds it, so a
# command tagged with it names a resource the registry cannot produce.
RESOURCES = ["hf_models", "hf_datasets", "hf_spaces"]

COMMANDS = [
    fn for resource in RESOURCES
    for fn in make_generic_commands(resource, _IO)
]
