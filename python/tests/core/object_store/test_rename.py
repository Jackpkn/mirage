import asyncio

import pytest

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.exists import make_exists
from mirage.core.object_store.rename import make_rename
from mirage.core.object_store.stat import make_stat
from tests.core.object_store.conftest import (FakeManager, FakeStore,
                                              make_driver, spec)


def _rename_for(store: FakeStore):
    driver = make_driver(store)
    return make_rename(driver, make_exists(make_stat(driver)))


def _managed(coro):
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        asyncio.run(coro)
    finally:
        push_cache_manager(prev)
    return manager


def test_rename_moves_a_file(accessor):
    store = FakeStore({"a/src.txt": b"hi"})
    manager = _managed(
        _rename_for(store)(accessor, spec("/a/src.txt"), spec("/b/dst.txt")))
    assert store.objects == {"b/dst.txt": b"hi"}
    assert manager.unlinks == ["/b/dst.txt", "/a/src.txt"]
    assert manager.writes == ["/b", "/a"]


def test_rename_falls_back_to_the_prefix_walk(accessor):
    store = FakeStore({"dir/f.txt": b"x", "dir/sub/g.txt": b"y"})
    _managed(_rename_for(store)(accessor, spec("/dir"), spec("/moved")))
    assert store.objects == {"moved/f.txt": b"x", "moved/sub/g.txt": b"y"}


def test_rename_missing_source_is_enoent(accessor):
    store = FakeStore()
    with pytest.raises(FileNotFoundError):
        _managed(_rename_for(store)(accessor, spec("/never"), spec("/dst")))


def test_rename_onto_the_same_key_is_a_guarded_no_op(accessor):
    store = FakeStore({"a.txt": b"hi"})
    manager = _managed(_rename_for(store)(accessor, spec("/a.txt"),
                                          spec("/a.txt")))
    assert store.objects == {"a.txt": b"hi"}
    assert manager.unlinks == []


def test_rename_onto_the_same_key_still_fails_when_absent(accessor):
    with pytest.raises(FileNotFoundError):
        _managed(_rename_for(FakeStore())(accessor, spec("/a.txt"),
                                          spec("/a.txt")))
