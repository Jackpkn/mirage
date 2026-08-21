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

import posixpath

from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec, word_text
from mirage.utils.path import CycleError
from mirage.workspace.executor.builtins.shared import (Result, abs_path, fail,
                                                       ok, split_flags)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session


async def handle_ln(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    """ln -s TARGET LINK: create a namespace symbolic link.

    Flags: -f remove the destination first (GNU's own algorithm, so it
    replaces a regular file too), -v report the link, -r store the
    target relative to the link's directory (GNU --relative). -n
    (--no-dereference) and -T (--no-target-directory) are accepted no-ops:
    a namespace link name is never dereferenced nor treated as a directory
    to descend into, so both are already the effective behavior.

    Divergence: GNU reads a directory destination as "link inside it"
    (``ln -s f.txt d`` creates ``d/f.txt``), and mirage refuses the name
    instead. Refusing is the safe half of that gap: the version before
    the door owned the existence rule buried the directory under a link
    node.

    The write itself is a dispatch op, so session grants and admission
    policies fire at the door; this handler keeps only the GNU operand
    semantics and renders a refusal in ln's own words.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        dispatch (DispatchFn): op dispatcher.
        session (Session): session whose cwd resolves relative operands.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, operands = split_flags(args, "sfnvrT")
    if len(operands) < 2:
        return fail("ln", "ln: missing file operand\n")
    # GNU: with more than two operands the last must be a directory;
    # namespace links never name directories, so this is always an error
    # (an expanded multi-match glob source lands here).
    if len(operands) > 2:
        return fail(
            "ln", f"ln: target '{word_text(operands[-1])}': "
            f"Not a directory\n")
    link_abs = abs_path(operands[1], session.cwd)
    target_typed = word_text(operands[0])
    if "r" in flags:
        # --relative: rewrite the target relative to the link's own
        # directory so the link stays valid addressed from anywhere. GNU
        # canonicalizes existing symlink components of both ends first, so
        # an aliased directory resolves to its real path (the link survives
        # the alias being moved/removed); fall back to lexical on a loop.
        link_dir = posixpath.dirname(link_abs) or "/"
        target_abs = abs_path(operands[0], session.cwd)
        try:
            target_abs = namespace.follow(target_abs)
            link_dir = namespace.follow(link_dir)
        except CycleError:
            pass
        target_typed = posixpath.relpath(target_abs, link_dir)
    if namespace.is_mount_root(link_abs):
        return fail(
            "ln", f"ln: failed to create symbolic link "
            f"'{word_text(operands[1])}': File exists\n")
    link_spec = PathSpec.from_str_path(link_abs)
    if "f" in flags:
        # GNU -f is "remove the destination, then link", which is why it
        # replaces a regular file and not only a link. The door refuses
        # an occupied name (symlink(2)'s EEXIST), so the removal is what
        # makes the flag work rather than a formality; a destination
        # that is not there is what -f is for, so its miss is the
        # expected case and not an error.
        try:
            await dispatch("unlink", link_spec)
        except FileNotFoundError:
            pass
        except IsADirectoryError:
            return fail(
                "ln", f"ln: {word_text(operands[1])}: "
                f"cannot overwrite directory\n")
    try:
        await dispatch("symlink", link_spec, target=target_typed)
    except FileExistsError:
        # The door owns the existence rule (it is the only layer that
        # can see both the node table and the backend); ln owns the
        # wording.
        return fail(
            "ln", f"ln: failed to create symbolic link "
            f"'{word_text(operands[1])}': File exists\n")
    except PermissionError:
        return fail(
            "ln", f"ln: failed to create symbolic link "
            f"'{word_text(operands[1])}': Permission denied\n")
    out = None
    if "v" in flags:
        out = (f"'{word_text(operands[1])}' -> '{target_typed}'\n").encode()
    return ok("ln", out)
