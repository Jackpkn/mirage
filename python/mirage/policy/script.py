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

import asyncio
from collections.abc import Mapping, Sequence

from mirage.policy.errors import PolicyError
from mirage.policy.profile import SessionProfile
from mirage.runtime.base import Runtime
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.script import eval_with_ctx, script_engine
from mirage.runtime.types import EvalValue, ScriptSource

SCRIPT_EVAL_TIMEOUT_SECONDS = 10.0


def script_context(name: str, mounts: Sequence[str]) -> dict[str, EvalValue]:
    """What a profile's script is told about the workspace.

    Deliberately small, and deliberately not per session: the script
    runs once for the profile, so it is told which profile it produces
    permissions for and where the mounts are, and nothing that varies
    between the sessions later created under it. A rule that depends on
    *who* is asking is the caller's to make by naming a different
    profile.

    Args:
        name (str): the profile the script produces permissions for.
        mounts (Sequence[str]): the workspace's mount prefixes.
    """
    return {"profile": name, "mounts": list(mounts)}


def _refuse(name: str, detail: str) -> PolicyError:
    """The one refusal wording, so every failure arm reads alike.

    Args:
        name (str): the profile whose script failed.
        detail (str): what went wrong.
    """
    return PolicyError(f"profile {name!r} script {detail}")


async def permissions_from_script(name: str, script: ScriptSource,
                                  context: dict[str, EvalValue],
                                  evaluator: EvaluatorMixin) -> SessionProfile:
    """Run one profile's script and validate the permissions it produced.

    Every failure arm raises, and none of them falls back to empty
    permissions: permissions that say nothing restrict nothing, so a
    script that raised, timed out or answered with the wrong shape
    would silently produce an unrestricted session, the opposite of
    what stating the script asked for.

    Args:
        name (str): the profile the script produces permissions for.
        script (ScriptSource): the program, as the config door loaded
            it.
        context (dict[str, EvalValue]): what the script sees as ``ctx``.
        evaluator (EvaluatorMixin): the engine to run it on.

    Raises:
        PolicyError: the script failed, timed out, or returned
            something other than permissions.
    """
    try:
        value = await eval_with_ctx(script.source, context, evaluator,
                                    SCRIPT_EVAL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise _refuse(
            name, f"timed out after {SCRIPT_EVAL_TIMEOUT_SECONDS:g}s") from exc
    except EvalError as exc:
        arm = "syntax error" if exc.syntax else "failed"
        raise _refuse(name, f"{arm}: {exc}") from exc
    if not isinstance(value, Mapping):
        raise _refuse(name, "must end in the permissions it produces")
    try:
        produced = SessionProfile.model_validate(dict(value))
    except ValueError as exc:
        raise _refuse(name, f"produced permissions that are not valid: {exc}")
    if produced.script is not None:
        raise _refuse(
            name, "produced another script; a script produces permissions")
    return produced


async def permissions_from_scripts(
        scripted: Mapping[str, SessionProfile],
        mounts: Sequence[str]) -> dict[str, SessionProfile]:
    """Run every profile's script, returning the permissions per name.

    All of them run before any result is returned, so one broken
    profile refuses the whole set rather than leaving the profiles that
    happened to be evaluated first done and the rest still scripts;
    without that, whether a session could be created depended on where
    its profile sat in the mapping. Permissions are operator
    configuration, so a workspace that cannot realize what it was given
    does not serve; every refusal names the profile.

    Engines are shared per kind rather than built per profile: each is
    a worker subprocess, so building one for every scripted profile
    would spawn N of them to run N short programs. Keyed on the class
    because ``name`` is declared by Runtime, not by the evaluator
    capability the engine is used as.

    Args:
        scripted (Mapping[str, SessionProfile]): the profiles that
            state a script, keyed by profile name.
        mounts (Sequence[str]): the workspace's mount prefixes.

    Raises:
        PolicyError: a script failed, named an engine it cannot have,
            or is still a path, which means it reached this layer
            without passing the config door that loads one.
    """
    produced: dict[str, SessionProfile] = {}
    engines: dict[type[Runtime], Runtime] = {}
    try:
        for name, profile in scripted.items():
            script = profile.script
            if isinstance(script, str):
                raise PolicyError(
                    f"profile {name!r} names a script by path ({script!r}); "
                    f"only the config door loads one, pass ScriptSource in "
                    f"code")
            assert script is not None
            try:
                engine = script_engine(script, profile.runtime)
            except ValueError as exc:
                raise PolicyError(f"profile {name!r} {exc}") from exc
            engine = engines.setdefault(type(engine), engine)
            # script_engine refuses anything that cannot evaluate, so
            # this narrows a fact already established.
            assert isinstance(engine, EvaluatorMixin)
            produced[name] = await permissions_from_script(
                name, script, script_context(name, mounts), engine)
    finally:
        for engine in engines.values():
            await engine.close()
    return produced
