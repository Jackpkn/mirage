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
from mirage.runtime.base import Runtime
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.table import NAMED, build_runtime
from mirage.runtime.types import EvalValue, Language, ScriptSource
from mirage.workspace.session.permissions import SessionProfile

PROFILE_EVAL_TIMEOUT_SECONDS = 10.0

# The sandboxed engine each language's role scripts run on. A role is
# operator configuration evaluated once before any agent exists, so it
# is deliberately NOT resolved out of the workspace's runtime world:
# that world is the ordered set that serves *agent* code, it is mutable
# after construction, an entry drops out of it silently when an optional
# dependency is missing, and a world configured for what the agent runs
# would decide which engine writes the document that governs the agent.
#
# monty on BOTH hosts, deliberately not DEFAULT_PYTHON. The two hosts
# disagree about the default python engine (monty here, pyodide in
# TypeScript) because `@pydantic/monty` cannot answer builtin `open()`
# calls yet, and agent code reads files. A role script does no file I/O
# at all: it is handed a context and returns a mapping. So the reason
# for that split does not reach here, and naming one engine means one
# source produces one document on either host rather than two engines
# that could disagree about the same program.
PROFILE_RUNTIMES: dict[Language, str] = {
    "python": "monty",
    "js": "quickjs",
}


def profile_context(name: str, mounts: Sequence[str]) -> dict[str, EvalValue]:
    """What a role's script is told about the workspace it writes for.

    Deliberately small, and deliberately not per session: the script
    runs once for the role, so it is told what the role is and where the
    mounts are, and nothing that varies between the sessions that will
    later be created from it. A rule that depends on *who* is asking is
    the caller's to make by naming a different role.

    Args:
        name (str): the role the script writes.
        mounts (Sequence[str]): the workspace's mount prefixes.
    """
    return {"profile": name, "mounts": list(mounts)}


def _refuse(name: str, detail: str) -> PolicyError:
    """The one refusal wording, so every failure arm reads alike.

    Args:
        name (str): the role whose script failed.
        detail (str): what went wrong.
    """
    return PolicyError(f"profile {name!r} script {detail}")


def profile_evaluator(name: str, script: ScriptSource,
                      runtime: str | None) -> Runtime:
    """The engine a role's script runs on, built for the role.

    Named explicitly by ``runtime`` when the role says so, otherwise the
    sandboxed engine for the script's language. Either way it is built
    here rather than picked out of the workspace's world, so which
    engine writes a permission document is a property of the document.

    Args:
        name (str): the role the script writes.
        script (ScriptSource): the program, carrying its language.
        runtime (str | None): the engine the role named, if any.

    Returns:
        Runtime: the engine, which every arm above has proved carries
        the evaluator capability. Typed as the Runtime it also is,
        because ``name`` and ``close`` are the runtime's and the mixin
        is capability-only; the caller narrows once to evaluate.

    Raises:
        PolicyError: the named runtime is unknown, cannot evaluate,
            speaks another language, or its dependency is missing.
    """
    wanted = runtime or PROFILE_RUNTIMES[script.language]
    named = NAMED.get(wanted)
    if runtime is not None and named is not None:
        # Both answerable from the table, so they are answered before
        # building: an engine that cannot be installed here would
        # otherwise report its missing dependency for a role that names
        # the wrong engine, which sends the operator after the wrong fix.
        if not issubclass(named, EvaluatorMixin):
            raise _refuse(
                name, f"names runtime {wanted!r}, which runs programs but "
                f"cannot evaluate one; use "
                f"{PROFILE_RUNTIMES[script.language]!r}")
        spoken = getattr(named, "language", None)
        if spoken is not None and spoken != script.language:
            raise _refuse(
                name, f"is {script.language}, but names runtime {wanted!r}, "
                f"which speaks {spoken}")
    try:
        built = build_runtime(wanted)
    except (ValueError, ImportError, OSError) as exc:
        # An engine reports a missing dependency as its own error
        # (ImportError for an absent extra, FileNotFoundError for
        # quickjs's absent wasm), and each carries its own install hint.
        # Unwrapped, the operator reads that engine's words with nothing
        # tying them to the role that asked.
        raise _refuse(name, f"names runtime {wanted!r}: {exc}") from exc
    if not isinstance(built, EvaluatorMixin):
        raise _refuse(name, f"names runtime {wanted!r}, which cannot evaluate")
    return built


async def evaluate_profile(name: str, script: ScriptSource,
                           context: dict[str, EvalValue],
                           evaluator: EvaluatorMixin) -> SessionProfile:
    """Run a role's script and validate the document it wrote.

    Every failure arm raises, and none of them falls back to an empty
    document: a role that says nothing restricts nothing, so a script
    that raised, timed out or answered with the wrong shape would
    silently produce an unrestricted session, which is the opposite of
    what stating the role asked for.

    Args:
        name (str): the role the script writes.
        script (ScriptSource): the program, as the config door loaded
            it.
        context (dict[str, EvalValue]): what the script sees as ``ctx``.
        evaluator (EvaluatorMixin): the engine profile_evaluator
            built for this role.

    Raises:
        PolicyError: the script failed, timed out, or returned
            something other than a permission document.
    """
    try:
        result = await asyncio.wait_for(evaluator.eval(script.source,
                                                       inputs={"ctx":
                                                               context}),
                                        timeout=PROFILE_EVAL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise _refuse(
            name,
            f"timed out after {PROFILE_EVAL_TIMEOUT_SECONDS:g}s") from exc
    except EvalError as exc:
        arm = "syntax error" if exc.syntax else "failed"
        raise _refuse(name, f"{arm}: {exc}") from exc
    value = result.value
    if not isinstance(value, Mapping):
        raise _refuse(name, "must end in the permission document it writes")
    try:
        written = SessionProfile.model_validate(dict(value))
    except ValueError as exc:
        raise _refuse(name, f"wrote a document that is not valid: {exc}")
    if written.script is not None:
        raise _refuse(name, "wrote another script; a script writes a document")
    return written
