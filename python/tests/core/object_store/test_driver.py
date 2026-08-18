import dataclasses

import pytest

from mirage.core.object_store.driver import (ChildEntry, FindHints,
                                             ObjectMeta, TreeEntry)
from tests.core.object_store.conftest import FakeStore, make_driver


def test_driver_is_frozen():
    driver = make_driver(FakeStore())
    with pytest.raises(dataclasses.FrozenInstanceError):
        driver.resource = "other"  # type: ignore[misc]


def test_find_tree_defaults_to_none():
    assert make_driver(FakeStore()).find_tree is None
    assert make_driver(FakeStore(), find_narrowing=True).find_tree is not None


def test_entry_defaults():
    assert ChildEntry(key="k", kind="f").size is None
    assert TreeEntry(key="k").size == 0
    meta = ObjectMeta(size=1)
    assert meta.extra == {}
    assert FindHints(name=None,
                     iname=None,
                     type=None,
                     min_size=None,
                     max_size=None,
                     pushdown=False).pushdown is False
