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

import dataclasses
from typing import Any, Generic, TypeVar

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.commands.builtin.hf_hub import COMMANDS as HF_COMMANDS
from mirage.commands.builtin.hf_hub.io import IO as HF_IO
from mirage.core.hf_hub.constants import INDEX_TTL
from mirage.core.hf_hub.create import create
from mirage.core.hf_hub.exists import exists
from mirage.core.hf_hub.mkdir import mkdir
from mirage.core.hf_hub.read import read_bytes
from mirage.core.hf_hub.readdir import readdir
from mirage.core.hf_hub.rm import rm_r
from mirage.core.hf_hub.stat import stat as hf_stat
from mirage.core.hf_hub.stream import range_read, read_stream
from mirage.core.hf_hub.unlink import unlink
from mirage.core.hf_hub.watch import build_delta_hook
from mirage.core.hf_hub.write import write_bytes
from mirage.ops.hf_hub import OPS as HF_OPS
from mirage.resource.base import BaseResource
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.watch.base import DeltaHook

# The accessor a subclass narrows to. TypeScript spells this as an abstract
# readonly field the subclass redeclares, which its covariant property rule
# allows; python attributes are invariant, so the same narrowing has to be a
# type parameter or mypy reads every subclass as an illegal override.
A = TypeVar("A", bound=HfHubAccessor)

_OPS = {
    "read_bytes": read_bytes,
    "readdir": readdir,
    "stat": hf_stat,
    "read_stream": read_stream,
    "range_read": range_read,
    "exists": exists,
    "write": write_bytes,
    "create": create,
    "unlink": unlink,
    "rm_r": rm_r,
    "mkdir": mkdir,
}


class HfHubResource(BaseResource, Generic[A]):
    """Everything a Hub repo mount does, for whichever repo type it is.

    Models, datasets and spaces are one API and one tree; they differ only
    in the `repo_type` their accessor sends and the prompt they carry. A
    subclass therefore declares `name`, `PROMPT` and the accessor class,
    and nothing else. Keeping the behaviour here rather than copying it
    three times is what the TypeScript side already does.
    """

    accessor: A
    ACCESSOR: type[A]
    caches_reads: bool = True
    # The Hub tree reports every file's exact byte size, and for an LFS
    # file that is the object's own size rather than the pointer's, so
    # no read can be short.
    SIZES_ALWAYS_KNOWN: bool = True
    # The index is not a cache in front of a listing, it IS the listing:
    # one recursive fetch seeds it whole. A long TTL therefore spares the
    # Hub a full re-walk rather than risking a stale row.
    index_ttl: float = INDEX_TTL
    _ops: dict[str, Any] = _OPS
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: Any) -> None:
        super().__init__()
        self.config = config
        self.accessor = self.ACCESSOR(self.config)
        for fn in HF_COMMANDS:
            self.register(fn)
        for op in HF_OPS:
            self.register_op(op)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def resolve_glob(
        self,
        paths: list[PathSpec],
        prefix: str = '',
    ) -> list[PathSpec]:
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await HF_IO.resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
