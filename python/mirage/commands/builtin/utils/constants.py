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

import re

from mirage.types import FileType

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
          "Nov", "Dec")

EPOCH_LS_TIME = "Jan  1 00:00"

# A terminal `cat` of an endless character device must be bounded before
# workspace materialization. Regular files keep the ordinary line-only cap.
CHAR_DEVICE_MAX_BYTES = 8 << 20

TYPE_CHARS = {
    FileType.DIRECTORY: "d",
    FileType.SYMLINK: "l",
    FileType.CHAR_DEVICE: "c",
    FileType.BLOCK_DEVICE: "b",
    FileType.FIFO: "p",
    FileType.SOCKET: "s",
}

# A symlink has no permission bits of its own on Linux: the mode is
# always 0777 and access is decided by the target, so GNU always renders
# lrwxrwxrwx. A device carries 0666 the way the kernel creates null/zero.
DEFAULT_MODES = {
    FileType.DIRECTORY: 0o755,
    FileType.SYMLINK: 0o777,
    FileType.CHAR_DEVICE: 0o666,
}

NUMERIC_PREFIX = re.compile(
    r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
