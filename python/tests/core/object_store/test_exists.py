# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

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
