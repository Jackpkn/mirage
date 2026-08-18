from unittest.mock import MagicMock

import pytest

from mirage.workspace.executor.builtins.whoami import handle_whoami
from mirage.workspace.mount.namespace import Namespace


@pytest.mark.asyncio
async def test_whoami_prints_workspace_user():
    out, io, node = await handle_whoami(Namespace(MagicMock(), user="alice"))
    assert io.exit_code == 0
    assert out == b"alice\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_whoami_errors_without_identity():
    out, io, _ = await handle_whoami(Namespace(MagicMock()))
    assert io.exit_code == 1
    assert out is None
    assert io.stderr == b"whoami: cannot find name for user ID\n"
