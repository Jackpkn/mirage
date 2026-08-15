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

from functools import partial

from mirage.accessor.box import BoxAccessor
from mirage.core.box.readdir import readdir
from mirage.core.box.stat import stat
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.walk import ReaddirWalk


def build_delta_hook(accessor: BoxAccessor) -> DeltaHook:
    """Build the Box delta hook.

    Box keys its tree by folder id and has no recursive listing, so the
    pull is one ``/folders/{id}/items`` request per directory. Box does
    offer an account-wide ``/events`` feed, which is the cheaper signal
    and belongs in a push receiver, not here.

    Fingerprints on ``modified_at``, which is what Box stat reports.

    Args:
        accessor (BoxAccessor): Backend handle.
    """
    return ListingDeltaHook(
        ReaddirWalk(partial(readdir, accessor), partial(stat, accessor)))
