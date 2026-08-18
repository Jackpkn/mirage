import time

import pytest

from mirage.workspace.executor.builtins.sleep import handle_sleep


@pytest.mark.asyncio
async def test_sleep_missing_operand_exits_1():
    _, io, node = await handle_sleep([])
    assert io.exit_code == 1
    assert io.stderr == b"sleep: missing operand\n"
    assert node.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    ["abc", "-1", "inf", "Infinity", "nan", "NaN", "0x10", "1_0", "1e309", ""])
async def test_sleep_invalid_interval_exits_1(raw):
    _, io, node = await handle_sleep([raw])
    assert io.exit_code == 1
    assert io.stderr == f"sleep: invalid time interval '{raw}'\n".encode()
    assert node.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", ["0", "0.", ".01", "+0.01", "1e-3"])
async def test_sleep_valid_interval_exits_0(raw):
    _, io, node = await handle_sleep([raw])
    assert io.exit_code == 0
    assert not io.stderr
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_sleep_zero_returns_promptly():
    start = time.monotonic()
    _, io, _ = await handle_sleep(["0"])
    assert io.exit_code == 0
    assert time.monotonic() - start < 0.05
