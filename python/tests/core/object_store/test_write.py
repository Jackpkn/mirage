import asyncio

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.write import (make_create, make_mkdir,
                                            make_truncate, make_write_bytes)
from tests.core.object_store.conftest import (FakeManager, FakeStore,
                                              make_driver, spec)


def _managed(coro):
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        asyncio.run(coro)
    finally:
        push_cache_manager(prev)
    return manager


def test_write_puts_and_invalidates_every_ancestor_listing(accessor):
    store = FakeStore()
    manager = _managed(
        make_write_bytes(make_driver(store))(accessor, spec("/a/b/c.txt"),
                                             b"hi"))
    assert store.objects == {"a/b/c.txt": b"hi"}
    assert manager.writes == ["/a/b/c.txt", "/a/b", "/a"]


def test_write_at_mount_root_invalidates_only_itself(accessor):
    store = FakeStore()
    manager = _managed(
        make_write_bytes(make_driver(store))(accessor, spec("/c.txt"), b"x"))
    assert manager.writes == ["/c.txt"]


def test_create_puts_empty_and_invalidates_ancestors(accessor):
    store = FakeStore()
    manager = _managed(
        make_create(make_driver(store))(accessor, spec("/a/b/c.txt")))
    assert store.objects == {"a/b/c.txt": b""}
    assert manager.writes == ["/a/b/c.txt", "/a/b", "/a"]


def test_truncate_pads_with_nul_and_invalidates_ancestors(accessor):
    store = FakeStore({"a/f.bin": b"0123456789"})
    manager = _managed(
        make_truncate(make_driver(store))(accessor, spec("/a/f.bin"), 4))
    assert store.objects["a/f.bin"] == b"0123"
    assert manager.writes == ["/a/f.bin", "/a"]


def test_truncate_extends_a_missing_key(accessor):
    store = FakeStore()
    _managed(make_truncate(make_driver(store))(accessor, spec("/f.bin"), 3))
    assert store.objects["f.bin"] == b"\0\0\0"


def test_mkdir_writes_a_marker_and_parents_gate_ancestors(accessor):
    store = FakeStore()
    manager = _managed(
        make_mkdir(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {"a/b/": b""}
    assert manager.writes == ["/a/b"]
    deep = _managed(
        make_mkdir(make_driver(store))(accessor, spec("/x/y"), parents=True))
    assert deep.writes == ["/x/y", "/x"]
