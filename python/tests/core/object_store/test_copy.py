import asyncio

import pytest

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.copy import make_copy
from mirage.core.object_store.exists import make_exists
from mirage.core.object_store.stat import make_stat
from tests.core.object_store.conftest import (FakeManager, FakeStore,
                                              make_driver, spec)


def _copy_for(store: FakeStore):
    driver = make_driver(store)
    return make_copy(driver, make_exists(make_stat(driver)))


def _managed(coro):
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        asyncio.run(coro)
    finally:
        push_cache_manager(prev)
    return manager


def test_copy_duplicates_and_invalidates_destination_ancestors(accessor):
    store = FakeStore({"src.txt": b"hi"})
    manager = _managed(
        _copy_for(store)(accessor, spec("/src.txt"), spec("/a/b/dst.txt")))
    assert store.objects == {"src.txt": b"hi", "a/b/dst.txt": b"hi"}
    assert manager.writes == ["/a/b/dst.txt", "/a/b", "/a"]


def test_copy_missing_source_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        _managed(_copy_for(FakeStore())(accessor, spec("/never"),
                                        spec("/dst.txt")))


def test_copy_onto_the_same_key_is_a_guarded_no_op(accessor):
    store = FakeStore({"a.txt": b"hi"})
    manager = _managed(_copy_for(store)(accessor, spec("/a.txt"),
                                        spec("/a.txt")))
    assert store.objects == {"a.txt": b"hi"}
    assert manager.writes == []


def test_copy_onto_the_same_key_still_fails_when_absent(accessor):
    with pytest.raises(FileNotFoundError):
        _managed(_copy_for(FakeStore())(accessor, spec("/a.txt"),
                                        spec("/a.txt")))
