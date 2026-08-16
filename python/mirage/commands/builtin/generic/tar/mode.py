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

from collections.abc import Sequence


def is_create_mode(argv: Sequence[str]) -> bool:
    """Whether a tar line reads the filesystem rather than an archive.

    Only ``-c`` makes tar's operands source paths. Under ``-t`` and
    ``-x`` they are member selectors matched against names inside the
    archive, so a selector that happens to spell a mount root is not a
    mount at all and refusing it would deny an ordinary listing.

    Scanned raw because both callers fire before flag parsing: the
    mount-root policy at admission, and the cross-mount router deciding
    whether a span is real. Only the first word may be GNU's dashless
    option cluster (``tar cf a.tar d``), so a later bare word is an
    operand and cannot turn the mode on.

    Args:
        argv (Sequence[str]): raw argv after the command name.
    """
    for i, tok in enumerate(argv):
        if not isinstance(tok, str):
            continue
        if tok == "--create":
            return True
        if tok.startswith("--"):
            continue
        if tok.startswith("-"):
            if "c" in tok[1:]:
                return True
            continue
        if i == 0 and "c" in tok:
            return True
    return False
