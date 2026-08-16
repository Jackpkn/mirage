import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.file_version import (FileVersionTracker,
                                        StaleMirageFileError, fingerprint)
from mirage.agents.tool_operations import MirageToolOperations


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


def test_fingerprint_is_stable_and_url_safe():
    stamp = fingerprint(b"hello")
    assert stamp == fingerprint(b"hello")
    assert stamp != fingerprint(b"hello!")
    assert "+" not in stamp and "/" not in stamp and "=" not in stamp


@pytest.mark.asyncio
async def test_write_after_read_of_unchanged_file(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_write_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"moved underneath"


@pytest.mark.asyncio
async def test_edit_refuses_after_outside_change(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    with pytest.raises(StaleMirageFileError):
        await tracker.read_for_edit("/a.txt")


@pytest.mark.asyncio
async def test_write_after_own_write_is_allowed(workspace):
    tracker = FileVersionTracker(workspace)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await tracker.write("/a.txt", "two")
    await tracker.write("/a.txt", "three")
    assert await workspace.ops.read("/a.txt") == b"three"


@pytest.mark.asyncio
async def test_disabled_tracker_allows_clobber(workspace):
    tracker = FileVersionTracker(workspace, enabled=False)
    await workspace.ops.write("/a.txt", b"one")
    await tracker.read("/a.txt")
    await workspace.ops.write("/a.txt", b"moved underneath")
    await tracker.write("/a.txt", "two")
    assert await workspace.ops.read("/a.txt") == b"two"


@pytest.mark.asyncio
async def test_edit_tool_reports_a_stale_file(workspace):
    ops = MirageToolOperations(workspace)
    await workspace.ops.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.ops.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is True
    assert "changed since it was last read" in result.text
    assert await workspace.ops.read("/a.txt") == b"hello there"


@pytest.mark.asyncio
async def test_edit_tool_without_protection_overwrites(workspace):
    ops = MirageToolOperations(workspace, stale_write_protection=False)
    await workspace.ops.write("/a.txt", b"hello world")
    await ops.read("/a.txt")
    await workspace.ops.write("/a.txt", b"hello there")
    result = await ops.edit("/a.txt", "hello", "goodbye")
    assert result.is_error is False
    assert await workspace.ops.read("/a.txt") == b"goodbye there"
