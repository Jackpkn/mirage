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

import pytest

from mirage.secrets.types import ResolvedSecret


def test_resolved_secret_defaults():
    secret = ResolvedSecret(fields={"a": "1"})
    assert secret.fields == {"a": "1"}
    assert secret.expires_at is None


def test_resolved_secret_is_frozen():
    secret = ResolvedSecret(fields={})
    with pytest.raises(Exception):
        secret.expires_at = 1.0  # type: ignore[misc]
