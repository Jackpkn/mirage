import asyncio

from mirage.core.object_store.exists import make_exists
from mirage.core.object_store.stat import make_stat
from tests.core.object_store.conftest import FakeStore, make_driver, spec


def test_exists_true_for_files_and_prefixes(accessor):
    store = FakeStore({"a.txt": b"hi", "dir/f.txt": b"x"})
    exists = make_exists(make_stat(make_driver(store)))
    assert asyncio.run(exists(accessor, spec("/a.txt")))
    assert asyncio.run(exists(accessor, spec("/dir")))


def test_exists_false_for_a_missing_path(accessor):
    exists = make_exists(make_stat(make_driver(FakeStore())))
    assert not asyncio.run(exists(accessor, spec("/never")))
