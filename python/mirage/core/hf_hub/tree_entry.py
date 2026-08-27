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


@dataclass(frozen=True, slots=True)
class TreeEntry:
    """One row of a Hub repository tree.

    Args:
        path (str): repo-relative path, no leading slash. A subtree
            listing reports full repo-relative paths too, not paths
            relative to the subtree, which is what lets a key_prefix
            mount fetch only its own subtree and strip the prefix.
        type (str): "file" or "directory", the Hub's own spelling.
        oid (str): the git object sha. Content-addressed, so it is the
            strongest fingerprint available and identical bytes carry an
            identical oid.
        size (int | None): the *content* length in bytes. For an LFS file
            this is the real size, never the 135-byte pointer; reporting
            the pointer would make wc -c and ls -l lie and risk truncated
            copies over FUSE.
        last_modified (str): the date of the commit that last touched the
            path, when the listing was expanded; "" otherwise.
        last_commit (str): that commit's id, when known.
        lfs_oid (str): the LFS sha256, "" for a regular git blob.
        xet_hash (str): the Xet content hash, "" when the file is not
            Xet-backed.
    """

    path: str
    type: str
    oid: str
    size: int | None = None
    last_modified: str = ""
    last_commit: str = ""
    lfs_oid: str = ""
    xet_hash: str = ""

    @property
    def is_dir(self) -> bool:
        return self.type == "directory"
