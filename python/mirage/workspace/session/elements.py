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
from collections.abc import Mapping

from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.arith import evaluate_arith
from mirage.shell.array import (array_count, array_extent, array_get,
                                array_has, array_with)
from mirage.shell.errors import ArithError
from mirage.shell.types import ElementOps
from mirage.shell.variable import ShellValue
from mirage.workspace.session.session import Session
from mirage.workspace.session.state import (ensure_var_visible, env_get,
                                            seed_var, visible_arrays,
                                            visible_assocs, visible_env)

_ELEMENT_REF = re.compile(r"([A-Za-z_]\w*)(?:\[(.+)\])?\Z", re.DOTALL)


def strip_key_quotes(text: str) -> str:
    """Remove one surrounding quote pair from an associative subscript.

    An arithmetic reference carries its subscript verbatim, so
    ``m["x"]`` arrives with the quotes bash would have removed; one
    layer comes off and anything else is the key itself.

    Args:
        text (str): the raw subscript text.
    """
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def element_index(subscript: str,
                  env: Mapping[str, str],
                  elements: ElementOps | None = None) -> int:
    """Resolve an indexed subscript in arithmetic context.

    bash evaluates indexed subscripts as arithmetic (``a[i+1]``); an
    unresolvable expression indexes element 0, mirroring bash's
    unset-name-is-zero arithmetic rule.

    Args:
        subscript (str): the raw subscript text.
        env (Mapping[str, str]): environment for name resolution.
        elements (ElementOps | None): element callbacks, so a nested
            reference (``a[b[0]]``) resolves too.
    """
    try:
        return int(subscript.strip())
    except ValueError:
        pass
    try:
        return evaluate_arith(subscript, env, elements=elements).value
    except ArithError:
        return 0


class _SessionElements:
    """The ``ElementOps`` implementation bound to one session.

    A class rather than closures because the resolver recurses: an
    indexed subscript is arithmetic and may itself hold an element
    reference, so ``resolve`` hands the evaluator the same pair of
    callbacks it is one of.
    """

    __slots__ = ("_session", )

    def __init__(self, session: Session) -> None:
        self._session = session

    def resolve(self, name: str, subscript: str, env: Mapping[str,
                                                              str]) -> str:
        """Canonical key for one reference.

        Args:
            name (str): the array variable's name.
            subscript (str): the raw subscript text.
            env (Mapping[str, str]): the evaluator's current view,
                pending assignments included.
        """
        if name in visible_assocs(self._session):
            return strip_key_quotes(subscript)
        idx = element_index(subscript, env, session_elements(self._session))
        if idx < 0:
            arr = visible_arrays(self._session).get(name)
            if arr is not None:
                idx += array_extent(arr)
            elif env_get(self._session, name) is not None:
                idx += 1
            if idx < 0:
                raise ArithError(f"{name}[{subscript}]: bad array subscript")
        return str(idx)

    def read(self, name: str, key: str) -> str | None:
        """The element's stored text, None when unset.

        Args:
            name (str): the array variable's name.
            key (str): the canonical key ``resolve`` produced.
        """
        session = self._session
        amap = visible_assocs(session).get(name)
        if amap is not None:
            return amap.get(key)
        arr = visible_arrays(session).get(name)
        idx = int(key)
        if arr is None:
            scalar = env_get(session, name)
            if scalar is None:
                return None
            return scalar if idx == 0 else None
        return array_get(arr, idx) if array_has(arr, idx) else None


def session_elements(session: Session) -> ElementOps:
    """Element callbacks bound to one session, for ``evaluate_arith``.

    Args:
        session (Session): the session references resolve against.
    """
    bound = _SessionElements(session)
    return ElementOps(resolve=bound.resolve, read=bound.read)


def element_is_set(session: Session, ref: str) -> bool:
    """Whether a ``name`` / ``name[sub]`` reference names a set value.

    What ``test -v`` asks. A bare name over an array checks element 0
    (the literal key ``"0"`` for an associative one), which is GNU's
    rule; ``name[@]`` and ``name[*]`` ask whether any element is set.
    An associative subscript is the key verbatim; an indexed one
    evaluates as arithmetic.

    Args:
        session (Session): shell session state.
        ref (str): the reference as the operand spelled it.
    """
    match = _ELEMENT_REF.fullmatch(ref)
    if match is None:
        return False
    name, sub = match.group(1), match.group(2)
    amap = visible_assocs(session).get(name)
    arr = visible_arrays(session).get(name)
    if sub is None:
        if amap is not None:
            return "0" in amap
        if arr is not None:
            return array_has(arr, 0)
        return env_get(session, name) is not None
    if sub in ("@", "*"):
        if amap is not None:
            return len(amap) > 0
        if arr is not None:
            return array_count(arr) > 0
        return env_get(session, name) is not None
    if amap is not None:
        return sub in amap
    scalar = env_get(session, name)
    held: list[str | None]
    if arr is not None:
        held = arr
    elif scalar is not None:
        held = [scalar]
    else:
        return False
    idx = element_index(sub, visible_env(session), session_elements(session))
    if idx < 0:
        idx += array_extent(held)
    return array_has(held, idx)


async def assign_element(session: Session,
                         view: SessionView | None,
                         name: str,
                         subscript: str | None,
                         value: str,
                         append: bool = False) -> str:
    """Assign one element (or a bare name resolved as element 0).

    The element mechanics are computed on a copy and the landing write
    goes through the door as the whole variable the write produces, so
    a refused write leaves nothing half-applied and a ``pre_session``
    rule sees ``m[k]=v`` as a write to ``m``. The subscript arrives
    already expanded: an associative name takes it as the key verbatim,
    an indexed one evaluates it as arithmetic.

    Args:
        session (Session): shell session state.
        view (SessionView | None): the session plane's gated door;
            None seeds directly (a writer outside a workspace).
        name (str): the target's base variable name.
        subscript (str | None): the ``[...]`` text, or None for a bare
            target, which bash resolves as element 0 of an array and a
            plain scalar otherwise.
        value (str): the text to store.
        append (bool): concatenate onto the existing element.

    Returns:
        str: ``"ok"``, ``"denied"``, ``"readonly"``, or ``"subscript"``.

    Raises:
        PolicyDenied: a pre_session rule refused the write; the caller
            renders the rule's own message.
    """
    try:
        ensure_var_visible(session, name)
    except PolicyDenied:
        return "denied"
    if name in session.readonly_vars:
        return "readonly"
    amap = session.assocs.get(name)
    stored: ShellValue
    if amap is not None:
        key = "0" if subscript is None else subscript
        if key == "":
            return "subscript"
        updated = dict(amap)
        updated[key] = (amap.get(key, "") + value) if append else value
        stored = updated
    else:
        arr = session.arrays.get(name)
        if subscript is None and arr is None:
            stored = (session.env.get(name, "") + value) if append else value
        else:
            if arr is None:
                scalar = session.env.get(name)
                # An existing scalar becomes element 0, even when
                # empty: bash resolves `x[-1]` against the length-1
                # array that produces.
                arr = [] if scalar is None else [scalar]
            idx = 0 if subscript is None else element_index(
                subscript, visible_env(session), session_elements(session))
            if idx < 0:
                idx += array_extent(arr)
            if idx < 0:
                return "subscript"
            base = array_get(arr, idx) if append else ""
            stored = array_with(arr, idx, base + value)
    if view is not None:
        await view.set(name, stored)
        return "ok"
    seed_var(session, name, stored)
    return "ok"
