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

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.client import _abs
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir, enotempty


async def rmdir(accessor: SSHAccessor,
                path: PathSpec,
                index: IndexCacheStore = NULL_INDEX) -> None:
    """Remove an empty directory over SFTP.

    The server enforces emptiness, so the work here is naming its
    refusal in the same vocabulary every other backend uses. SFTP 3 has
    one code for it (``SFTPFailure``, carrying only the server's message
    string), and later protocol versions split ``SFTPDirNotEmpty`` out;
    only the typed one can be mapped, so a version-3 server still
    reaches the caller as itself.

    Args:
        accessor (SSHAccessor): SSH accessor.
        path (PathSpec): directory to remove.
        index (IndexCacheStore): accepted for the rmdir slot's shape;
            unused.
    """
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        await sftp.rmdir(_abs(config, path.mount_path))
    except asyncssh.SFTPNoSuchFile as exc:
        raise enoent(path) from exc
    except asyncssh.SFTPDirNotEmpty as exc:
        raise enotempty(path) from exc
    except asyncssh.SFTPNotADirectory as exc:
        raise enotdir(path) from exc
    await invalidate_after_unlink(path)
