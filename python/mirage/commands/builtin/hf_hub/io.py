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

from mirage.commands.builtin.generic_bind import CommandIO
from mirage.core.hf_hub.constants import SCOPE_ERROR
from mirage.core.hf_hub.create import create as _create
from mirage.core.hf_hub.exists import exists as _exists
from mirage.core.hf_hub.mkdir import mkdir as _mkdir
from mirage.core.hf_hub.read import read_bytes as _read
from mirage.core.hf_hub.readdir import readdir as _readdir
from mirage.core.hf_hub.rm import rm_r as _rm_r
from mirage.core.hf_hub.stat import stat as _stat
from mirage.core.hf_hub.stream import range_read as _range_read
from mirage.core.hf_hub.stream import read_stream as _read_stream
from mirage.core.hf_hub.unlink import unlink as _unlink
from mirage.core.hf_hub.write import write_bytes as _write

# No native find or du op, and that is not an omission. Those exist to
# spare an API tree one request per directory, and this mount has no such
# cost: the Hub's listing is recursive, so one paged fetch is the whole
# tree and every readdir under the generic walk is a dictionary lookup
# against it. A native walk here would buy a constant factor and cost a
# second implementation of the same traversal.
#
# cp and mv are absent because the Hub has no server-side copy or rename;
# both would be read-then-commit, which the generic already spells.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_range=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
    write=_write,
    exists=_exists,
    mkdir=_mkdir,
    unlink=_unlink,
    rm_r=_rm_r,
    create=_create,
    max_glob_matches=SCOPE_ERROR,
)

range_read = _range_read
resolve_glob = IO.resolve_glob
