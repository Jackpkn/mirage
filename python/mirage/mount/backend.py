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

from mirage.types import KERNEL_BACKENDS, MountBackend


def resolve_backend(value: "str | MountBackend | None") -> MountBackend:
    """Coerce a user-supplied backend name into a MountBackend.

    Missing means VFS, everywhere: an absent ``backend`` in YAML, ``None``
    here, and the ``Mount`` dataclass default all resolve to the same thing.
    Callers that need a kernel mount say so explicitly rather than relying
    on this function to reinterpret an absent value.

    Args:
        value (str | MountBackend | None): the requested backend; None and
            the empty string mean VFS.

    Returns:
        MountBackend: the resolved backend.

    Raises:
        ValueError: the name is not a known backend.
    """
    if value is None or value == "":
        return MountBackend.VFS
    try:
        return MountBackend(str(value).lower())
    except ValueError:
        known = ", ".join(b.value for b in MountBackend)
        raise ValueError(
            f"unknown mount backend {value!r}; expected one of: {known}")


def require_kernel_backend(backend: MountBackend) -> None:
    """Reject a backend that registers nothing with the kernel.

    Args:
        backend (MountBackend): the resolved backend.

    Raises:
        ValueError: the backend is VFS, so there is no mount to make.
    """
    if backend not in KERNEL_BACKENDS:
        raise ValueError(
            f"backend {backend.value!r} does not register a mountpoint; it "
            "is served inside mirage's own filesystem, so there is nothing "
            "to mount")
