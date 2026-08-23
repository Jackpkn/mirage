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

from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.vfs import RuntimeVFS


class MontyVFS:
    """Monty's mount view: the shared core plus a negative cache.

    Monty asks whether a path exists on nearly every guest expression,
    so a path the mount already answered "not there" for must not cost
    a second dispatch. Reads and listings return None for a miss rather
    than raising, which is the shape the encoder above wants, and every
    mutation keeps the cache honest.

    Args:
        core (RuntimeVFS | None): the shared op vocabulary, or None
            when the runtime was built without a workspace.
    """

    def __init__(self, core: RuntimeVFS | None) -> None:
        self._core = core
        self._missing: set[str] = set()

    @property
    def wired(self) -> bool:
        """True when a workspace dispatch is reachable."""
        return self._core is not None

    def read(self, virtual: str) -> bytes | None:
        """The file's bytes, or None when the mount does not have it."""
        if self._core is None or virtual in self._missing:
            return None
        try:
            return self._core.read(virtual)
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError,
                ValueError):
            self._missing.add(virtual)
            return None

    def readdir(self, virtual: str) -> list[VFSEntry] | None:
        """The directory's entries, or None when it is not a directory."""
        if self._core is None:
            return None
        try:
            return self._core.readdir(virtual)
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError,
                ValueError):
            return None

    def stat(self, virtual: str) -> VFSStat | None:
        """The path's row, or None when the mount does not have it.

        There is no TypeScript twin, and not for want of one: that
        binding converts whatever its os callback returns structurally,
        so a stat comes back to the guest as a dict and `st.st_size`
        raises AttributeError. Python's binding hands over an `OSAccess`
        subclass instead, which can build monty's own `StatResult`.

        Args:
            virtual (str): the path to stat.
        """
        if self._core is None or virtual in self._missing:
            return None
        try:
            return self._core.stat(virtual)
        except (FileNotFoundError, NotADirectoryError, ValueError):
            self._missing.add(virtual)
            return None

    def is_link(self, virtual: str) -> bool:
        """Whether the mount's name plane holds a symlink at `virtual`.

        Answered through the readlink op, not through the parent's
        listing, even though a readdir row now carries the mark. Two
        reasons, and both are about this tier rather than about the
        mark. The predicate arrives for one path with no listing in
        hand, and every other predicate here materializes that path
        alone, so reading the parent would trade one dispatch for a
        readdir plus a stat per sibling (the TS twin reads the row
        because its own `exists` and `is_file` already go through that
        listing). And readlink is the gated channel: the node table has
        no session, so a mark read outside an admitted listing would
        answer for a path the door hides.

        Args:
            virtual (str): the path to test.
        """
        if self._core is None:
            return False
        try:
            self._core.readlink(virtual)
        except OSError:
            # EINVAL for a path that is not a link, ENOENT for one that
            # is not there: `is_symlink` is False either way, which is
            # what pathlib answers for both.
            return False
        return True

    def write(self, virtual: str, data: bytes) -> None:
        if self._core is None:
            return
        self._core.write(virtual, data)
        self._missing.discard(virtual)

    def append(self, virtual: str, data: bytes, whole: bytes) -> None:
        """Ship only `data`, falling back to writing `whole`.

        Args:
            virtual (str): the file being appended to.
            data (bytes): only the newly appended bytes.
            whole (bytes): full content, for a mount with no append op.
        """
        if self._core is None:
            return
        self._core.append(virtual, data, whole)
        self._missing.discard(virtual)

    def create(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.create(virtual)
        self._missing.discard(virtual)

    def truncate(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.truncate(virtual)
        self._missing.discard(virtual)

    def mkdir(self, virtual: str, parents: bool) -> None:
        if self._core is None:
            return
        self._core.call("mkdir", virtual, parents=parents)
        self._missing.discard(virtual)

    def rmdir(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.rmdir(virtual)
        self._missing.add(virtual)

    def unlink(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.unlink(virtual)
        self._missing.add(virtual)

    def rename(self, src: str, dst: str) -> None:
        """Rename within one mount.

        Args:
            src (str): the source path.
            dst (str): the destination path.

        Raises:
            CrossMountError: the two ends live on different mounts.
        """
        if self._core is None:
            return
        self._core.rename(src, dst)
        self._missing.add(src)
        self._missing.discard(dst)
