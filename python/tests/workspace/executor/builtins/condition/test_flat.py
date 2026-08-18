from typing import cast

import pytest

from mirage.workspace.executor.builtins.condition import (CondContext,
                                                          CondError, eval_flat)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session


class _StubNamespace:
    """Namespace stand-in with no symlinks."""

    def symlink_targets(self) -> dict[str, str]:
        return {}

    def is_link(self, path: str) -> bool:
        return False


class _StubSession:
    """Session stand-in exposing only what the evaluator touches."""

    cwd = "/data"


def _ctx() -> CondContext:
    return CondContext(dispatch=None,
                       namespace=cast(Namespace, _StubNamespace()),
                       session=cast(Session, _StubSession()),
                       name="test")


@pytest.mark.asyncio
async def test_flat_arity_zero_one_two():
    assert await eval_flat(_ctx(), []) is False
    assert await eval_flat(_ctx(), ["x"]) is True
    assert await eval_flat(_ctx(), [""]) is False
    assert await eval_flat(_ctx(), ["-z", ""]) is True
    assert await eval_flat(_ctx(), ["-n", "abc"]) is True
    assert await eval_flat(_ctx(), ["!", ""]) is True


@pytest.mark.asyncio
async def test_flat_binary_string_and_integer_operators():
    assert await eval_flat(_ctx(), ["a", "=", "a"]) is True
    assert await eval_flat(_ctx(), ["a", "!=", "b"]) is True
    assert await eval_flat(_ctx(), ["3", "-lt", "10"]) is True
    assert await eval_flat(_ctx(), ["10", "-le", "3"]) is False
    assert await eval_flat(_ctx(), ["!", "a", "=", "b"]) is True


@pytest.mark.asyncio
async def test_flat_and_or_and_parentheses():
    assert await eval_flat(_ctx(), ["a", "-a", ""]) is False
    assert await eval_flat(_ctx(), ["", "-o", "b"]) is True
    assert await eval_flat(_ctx(), ["(", "a", "=", "a", ")"]) is True


@pytest.mark.asyncio
async def test_flat_reports_a_bad_integer_as_an_error():
    with pytest.raises(CondError):
        await eval_flat(_ctx(), ["x", "-eq", "1"])
