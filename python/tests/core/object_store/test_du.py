import asyncio

from mirage.core.object_store.du import make_du_entries, make_du_size
from tests.core.object_store.conftest import FakeStore, make_driver, spec

_STORE = {
    "data/a.txt": b"12345",
    "data/sub/b.txt": b"123",
    "data-old/c.txt": b"1",
}


def test_du_entries_reports_sizes_and_total(accessor):
    entries = make_du_entries(make_driver(FakeStore(_STORE)))
    found, total = asyncio.run(entries(accessor, spec("/data")))
    assert found == [("/data/a.txt", 5), ("/data/sub/b.txt", 3)]
    assert total == 8


def test_du_size_matches_the_entries_total(accessor):
    driver = make_driver(FakeStore(_STORE))
    found, total = asyncio.run(
        make_du_entries(driver)(accessor, spec("/data")))
    assert asyncio.run(make_du_size(driver)(accessor,
                                            spec("/data"))) == total


def test_du_of_a_single_file_counts_just_it(accessor):
    size = make_du_size(make_driver(FakeStore(_STORE)))
    assert asyncio.run(size(accessor, spec("/data/a.txt"))) == 5
