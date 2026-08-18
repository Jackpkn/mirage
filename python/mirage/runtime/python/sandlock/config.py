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

from dataclasses import dataclass, field

from mirage.runtime.config import RuntimeConfig


@dataclass(frozen=True, slots=True, kw_only=True)
class SandlockConfig(RuntimeConfig):
    """What the confined interpreter may reach, and which one runs.

    Args:
        home (str | None): interpreter path or command name. None
            reads MIRAGE_SANDLOCK_HOME, then falls back to the
            interpreter running mirage.
        fs_readable (tuple[str, ...]): extra paths the code may read,
            on top of the interpreter's own tree and the system paths
            CPython needs to start.
        fs_writable (tuple[str, ...]): paths the code may write. A
            mirage FUSE mountpoint listed here is how confined code
            works on workspace files.
        max_memory (str | None): sandlock's memory cap for the run
            (its own spelling, e.g. "512M"). None leaves it uncapped.
        env (dict[str, str]): environment set for the run. Nothing is
            inherited from the mirage process, so anything the code
            needs must be named here.
    """

    home: str | None = None
    fs_readable: tuple[str, ...] = ()
    fs_writable: tuple[str, ...] = ()
    max_memory: str | None = None
    env: dict[str, str] = field(default_factory=dict)
