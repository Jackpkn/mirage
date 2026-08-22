import asyncio

import pytest

from mirage.policy.errors import PolicyError
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.table import NAMED
from mirage.runtime.types import EvalResult, EvalValue, ScriptSource
from mirage.workspace.session.script import (PROFILE_RUNTIMES,
                                             evaluate_profile, profile_context,
                                             profile_evaluator)

DOC = {"commands": {"allow": ["ls", "cat"]}, "cwd": "/repo"}


class FakeEvaluator(EvaluatorMixin):
    """Stands in for the world's policy engine, recording what it saw."""

    def __init__(self,
                 value: EvalValue = None,
                 error: Exception | None = None,
                 delay: float = 0.0,
                 language: str = "python") -> None:
        self.value = value
        self.error = error
        self.delay = delay
        self.language = language
        self.seen: dict[str, EvalValue] = {}
        self.code = ""

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        self.code = code
        self.seen = dict(inputs or {})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return EvalResult(value=self.value)


def test_profile_context_names_the_role_and_the_mounts():
    ctx = profile_context("release", ["/repo/", "/scratch/"])
    assert ctx == {"profile": "release", "mounts": ["/repo/", "/scratch/"]}


def test_profile_context_carries_nothing_per_session():
    # The script runs once for the role, so a per-session fact reaching
    # it would be a promise the one evaluation cannot keep.
    ctx = profile_context("release", [])
    assert "session_id" not in ctx
    assert "agent_id" not in ctx


@pytest.mark.asyncio
async def test_evaluate_profile_validates_what_the_script_wrote():
    engine = FakeEvaluator(DOC)
    written = await evaluate_profile("release", ScriptSource("..."),
                                     profile_context("release", ["/repo/"]),
                                     engine)
    assert written.cwd == "/repo"
    assert written.commands is not None
    assert written.commands.allow == ("ls", "cat")


@pytest.mark.asyncio
async def test_evaluate_profile_shows_the_script_its_context():
    engine = FakeEvaluator(DOC)
    ctx = profile_context("release", ["/repo/"])
    await evaluate_profile("release", ScriptSource("SOURCE"), ctx, engine)
    assert engine.code == "SOURCE"
    assert engine.seen == {"ctx": ctx}


@pytest.mark.asyncio
async def test_evaluate_profile_refuses_a_script_that_raised():
    engine = FakeEvaluator(error=EvalError("boom"))
    with pytest.raises(PolicyError, match="script failed: boom"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


@pytest.mark.asyncio
async def test_evaluate_profile_names_a_syntax_error_as_one():
    engine = FakeEvaluator(error=EvalError("bad token", syntax=True))
    with pytest.raises(PolicyError, match="script syntax error"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


@pytest.mark.asyncio
async def test_evaluate_profile_refuses_a_script_that_timed_out(monkeypatch):
    monkeypatch.setattr(
        "mirage.workspace.session.script."
        "PROFILE_EVAL_TIMEOUT_SECONDS", 0.01)
    engine = FakeEvaluator(DOC, delay=0.2)
    with pytest.raises(PolicyError, match="timed out"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, [1, 2], "commands", 7])
async def test_evaluate_profile_refuses_anything_but_a_document(value):
    # An empty document restricts nothing, so a wrong shape must never
    # coerce to one; every arm here has to raise rather than fall back.
    engine = FakeEvaluator(value)
    with pytest.raises(PolicyError, match="must end in the permission"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


@pytest.mark.asyncio
async def test_evaluate_profile_refuses_a_document_that_is_not_valid():
    engine = FakeEvaluator({"commands": {"allow": "ls"}})
    with pytest.raises(PolicyError, match="not valid"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


@pytest.mark.asyncio
async def test_evaluate_profile_refuses_a_script_that_wrote_a_script():
    engine = FakeEvaluator({"script": "roles/other.py"})
    with pytest.raises(PolicyError, match="wrote another script"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


@pytest.mark.asyncio
async def test_evaluate_profile_names_the_role_in_every_refusal():
    engine = FakeEvaluator([])
    with pytest.raises(PolicyError, match="profile 'release' script"):
        await evaluate_profile("release", ScriptSource("..."), {}, engine)


def test_profile_runtimes_names_monty_not_the_host_default():
    # Deliberately not DEFAULT_PYTHON: the two hosts disagree about that
    # (pyodide in TypeScript) for a reason that is about agent code
    # reading files, which a role script never does. Naming one engine
    # keeps one source producing one document on either host.
    assert PROFILE_RUNTIMES == {"python": "monty", "js": "quickjs"}


def test_every_profile_runtime_can_actually_evaluate():
    for language, runtime in PROFILE_RUNTIMES.items():
        assert issubclass(NAMED[runtime], EvaluatorMixin), language


def test_profile_evaluator_defaults_to_the_language_engine():
    engine = profile_evaluator("release", ScriptSource("..."), None)
    assert engine.name == "monty"
    assert isinstance(engine, EvaluatorMixin)


def test_profile_evaluator_takes_the_runtime_the_role_named():
    engine = profile_evaluator("release", ScriptSource("..."), "monty")
    assert engine.name == "monty"


def test_profile_evaluator_refuses_a_runtime_that_cannot_evaluate():
    for runtime in ("local", "sandlock", "wasi"):
        with pytest.raises(PolicyError, match="cannot evaluate one"):
            profile_evaluator("release", ScriptSource("..."), runtime)


def test_profile_evaluator_refuses_an_unknown_runtime():
    with pytest.raises(PolicyError, match="unknown runtime"):
        profile_evaluator("release", ScriptSource("..."), "nope")


def test_profile_evaluator_refuses_a_runtime_of_the_wrong_language():
    # Answered from the table before building, so a role naming the
    # wrong engine reads as that, not as the engine's install hint.
    with pytest.raises(PolicyError, match="python, but names runtime"):
        profile_evaluator("release", ScriptSource("..."), "quickjs")
