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

from mirage.commands.config import RegisteredCommand
from mirage.workspace.mount.mount import MountEntry


@dataclass
class ManHit:
    """One place a command name resolves to, for the manual renderer.

    Args:
        mount (MountEntry): the mount that registers the command.
        cmd (RegisteredCommand): the registration on that mount.
        is_general (bool): whether it is the general (every-mount) set.
    """
    mount: MountEntry
    cmd: RegisteredCommand
    is_general: bool
