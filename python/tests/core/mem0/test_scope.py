from mirage.core.mem0.scope import ScopeLevel, detect_scope
from mirage.types import PathSpec


def test_root():
    s = detect_scope(
        PathSpec(virtual="/mem", directory="/mem", resource_path=""))
    assert s.level == ScopeLevel.ROOT
    assert s.memory_id is None


def test_memory_file():
    p = PathSpec(virtual="/mem/abc.json",
                 directory="/mem",
                 resource_path="abc.json")
    s = detect_scope(p)
    assert s.level == ScopeLevel.MEMORY
    assert s.memory_id == "abc"


def test_hidden_is_invalid():
    p = PathSpec(virtual="/mem/.secret",
                 directory="/mem",
                 resource_path=".secret")
    s = detect_scope(p)
    assert s.level == ScopeLevel.INVALID


def test_empty_memory_id_is_invalid():
    p = PathSpec(virtual="/mem/.json", directory="/mem", resource_path=".json")
    assert detect_scope(p).level == ScopeLevel.INVALID
