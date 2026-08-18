import asyncio

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.remove import make_remove_prefix, make_unlink
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


def test_unlink_deletes_and_invalidates_every_ancestor_listing(accessor):
    # Deleting the last key under a/b makes /a/b and /a disappear as
    # implied prefixes; the stale-ancestor eviction is the pinned fix.
    store = FakeStore({"a/b/c.txt": b"hi"})
    manager = _managed(
        make_unlink(make_driver(store))(accessor, spec("/a/b/c.txt")))
    assert store.objects == {}
    assert manager.unlinks == ["/a/b/c.txt"]
    assert manager.writes == ["/a/b", "/a"]


def test_remove_prefix_deletes_the_subtree_and_ancestors_evict(accessor):
    store = FakeStore({"a/b/c.txt": b"hi", "a/b/d/e.txt": b"x"})
    manager = _managed(
        make_remove_prefix(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {}
    assert manager.unlinks == ["/a/b"]
    assert manager.writes == ["/a"]
