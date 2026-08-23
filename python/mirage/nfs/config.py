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

DEFAULT_PORT = 20490
DEFAULT_HOST = "127.0.0.1"
DEFAULT_IDLE_FLUSH_SECONDS = 5.0
DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class NFSConfig:
    """Knobs for one NFS-backed mount.

    Args:
        host (str): address the server binds. Loopback only by default:
            an NFSv3 export has no authentication of its own, so binding
            anywhere reachable would publish the workspace unguarded.
        port (int): TCP port serving both the MOUNT and NFS programs, so
            no portmapper is needed. 0 asks the OS for a free port.
        idle_flush_seconds (float): how long a handle's buffered writes
            may sit before the adapter flushes them. NFSv3 gives the
            adapter no COMMIT signal through this server, so this bounds
            the window in which a crash loses acknowledged writes.
        max_buffered_bytes (int): per-handle ceiling that forces an early
            flush, so a client that never stops writing cannot grow the
            buffer without bound.
    """

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    idle_flush_seconds: float = DEFAULT_IDLE_FLUSH_SECONDS
    max_buffered_bytes: int = DEFAULT_MAX_BUFFERED_BYTES

    def __post_init__(self) -> None:
        if not 0 <= self.port <= 65535:
            raise ValueError(f"port out of range: {self.port}")
        if self.idle_flush_seconds <= 0:
            raise ValueError("idle_flush_seconds must be positive: "
                             f"{self.idle_flush_seconds}")
        if self.max_buffered_bytes <= 0:
            raise ValueError("max_buffered_bytes must be positive: "
                             f"{self.max_buffered_bytes}")
