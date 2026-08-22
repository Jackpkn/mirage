import asyncio

import pytest

from mirage.policy.errors import PolicyError
from mirage.policy.profile import SessionProfile
from mirage.policy.script import (permissions_from_script,
                                  permissions_from_scripts, script_context)
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.types import EvalResult, EvalValue, ScriptSource

DOC = {"commands": {"allow": ["ls", "cat"]}, "cwd": "/repo"}


class FakeEngine(EvaluatorMixin):
    """Stands in for a built engine, recording what it saw."""

    built: list["FakeEngine"] = []

    def __init__(self,
                 value: EvalValue = None,
                 error: Exception | None = None,
                 delay: float = 0.0) -> None:
        self.value = value
        self.error = error
        self.delay = delay
        self.seen: dict[str, EvalValue] = {}
        self.code = ""
        self.evals = 0
        self.closed = False
        FakeEngine.built.append(self)

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        self.code = code
        self.seen = dict(inputs or {})
        self.evals += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return EvalResult(value=self.value)

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_built():
    FakeEngine.built = []


def _scripted(**runtimes: str | None) -> dict[str, SessionProfile]:
    """Profiles stating one script each, keyed by profile name.

    Args:
        runtimes (str | None): the engine each named profile states,
            None for the language default.
    """
    return {
        name: SessionProfile(script=ScriptSource("..."), runtime=runtime)
        for name, runtime in runtimes.items()
    }


def test_script_context_names_the_profile_and_the_mounts():
    ctx = script_context("release", ["/repo/", "/scratch/"])
    assert ctx == {"profile": "release", "mounts": ["/repo/", "/scratch/"]}


def test_script_context_carries_nothing_per_session():
    # The script runs once for the profile, so a per-session fact
    # reaching it would be a promise the one evaluation cannot keep.
    ctx = script_context("release", [])
    assert "session_id" not in ctx
    assert "agent_id" not in ctx


@pytest.mark.asyncio
async def test_the_produced_permissions_are_validated():
    engine = FakeEngine(DOC)
    produced = await permissions_from_script(
        "release", ScriptSource("..."), script_context("release", ["/repo/"]),
        engine)
    assert produced.cwd == "/repo"
    assert produced.commands is not None
    assert produced.commands.allow == ("ls", "cat")


@pytest.mark.asyncio
async def test_the_script_is_shown_its_context():
    engine = FakeEngine(DOC)
    ctx = script_context("release", ["/repo/"])
    await permissions_from_script("release", ScriptSource("SOURCE"), ctx,
                                  engine)
    assert engine.code == "SOURCE"
    assert engine.seen == {"ctx": ctx}


@pytest.mark.asyncio
async def test_a_script_that_raised_is_refused():
    engine = FakeEngine(error=EvalError("boom"))
    with pytest.raises(PolicyError, match="script failed: boom"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
async def test_a_syntax_error_is_named_as_one():
    engine = FakeEngine(error=EvalError("bad token", syntax=True))
    with pytest.raises(PolicyError, match="script syntax error"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
async def test_a_script_that_timed_out_is_refused(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.SCRIPT_EVAL_TIMEOUT_SECONDS",
                        0.01)
    engine = FakeEngine(DOC, delay=0.2)
    with pytest.raises(PolicyError, match="timed out"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, [1, 2], "commands", 7])
async def test_anything_but_permissions_is_refused(value):
    # Empty permissions restrict nothing, so a wrong shape must never
    # coerce to one; every arm here has to raise rather than fall back.
    engine = FakeEngine(value)
    with pytest.raises(PolicyError, match="must end in the permissions"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
async def test_permissions_that_are_not_valid_are_refused():
    engine = FakeEngine({"commands": {"allow": "ls"}})
    with pytest.raises(PolicyError, match="not valid"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
async def test_a_script_that_produced_a_script_is_refused():
    engine = FakeEngine({"script": "roles/other.py"})
    with pytest.raises(PolicyError, match="produced another script"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
async def test_every_refusal_names_the_profile():
    engine = FakeEngine([])
    with pytest.raises(PolicyError, match="profile 'release' script"):
        await permissions_from_script("release", ScriptSource("..."), {},
                                      engine)


@pytest.mark.asyncio
async def test_a_script_still_spelled_as_a_path_is_refused():
    scripted = {
        "release": SessionProfile.model_validate({"script": "roles/x.py"})
    }
    with pytest.raises(PolicyError, match="names a script by path"):
        await permissions_from_scripts(scripted, [])


def _no_engine(script: ScriptSource, runtime: str | None = None) -> FakeEngine:
    raise ValueError(f"script names runtime {runtime!r}: nope")


def _good_engine(script: ScriptSource,
                 runtime: str | None = None) -> FakeEngine:
    return FakeEngine(DOC)


def _broken_engine(script: ScriptSource,
                   runtime: str | None = None) -> FakeEngine:
    return FakeEngine(error=EvalError("boom"))


@pytest.mark.asyncio
async def test_an_engine_refusal_is_worded_for_the_profile(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.script_engine", _no_engine)
    with pytest.raises(PolicyError,
                       match="profile 'release' script names runtime"):
        await permissions_from_scripts(_scripted(release="ghost"), [])


@pytest.mark.asyncio
async def test_profiles_of_one_language_share_one_engine(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.script_engine", _good_engine)
    produced = await permissions_from_scripts(_scripted(a=None, b=None), [])
    assert set(produced) == {"a", "b"}
    # One engine is built per call, but only the first of a kind is
    # kept: both scripts ran on it, and it alone was closed.
    kept = FakeEngine.built[0]
    assert kept.evals == 2
    assert kept.closed


@pytest.mark.asyncio
async def test_the_engine_is_closed_when_a_script_fails(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.script_engine", _broken_engine)
    with pytest.raises(PolicyError, match="profile 'release' script failed"):
        await permissions_from_scripts(_scripted(release=None), [])
    assert FakeEngine.built[0].closed
