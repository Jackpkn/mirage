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


class HttpConnectError(Exception):
    """The request never got an HTTP response.

    Carries the host and port instead of an errno: the errno for a refused
    connection differs by platform (61 on macOS, 111 on Linux), so a message
    built from it cannot be asserted in a cross-platform test.

    Args:
        host (str): host from the requested URL.
        port (int): port from the requested URL, defaulted by scheme.
    """

    def __init__(self, host: str, port: int) -> None:
        super().__init__(f"Failed to connect to {host} port {port}")
        self.host = host
        self.port = port


class SortKeyError(ValueError):
    """An invalid -k field specification or ordering letter (GNU sort)."""
