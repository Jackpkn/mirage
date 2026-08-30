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
from pydantic import ValidationError

from mirage.secrets.types import EnvVar, ResolvedSecret


def test_resolved_secret_defaults():
    secret = ResolvedSecret(fields={"a": "1"})
    assert secret.fields == {"a": "1"}
    assert secret.expires_at is None


def test_resolved_secret_is_frozen():
    secret = ResolvedSecret(fields={})
    with pytest.raises(Exception):
        secret.expires_at = 1.0  # type: ignore[misc]


def test_literal_short_and_long_defaults():
    entry = EnvVar(value="vim")
    assert entry.readonly is False
    assert entry.export is True
    assert entry.provider is None


def test_from_alias_and_provider_spelling_agree():
    # YAML spells `from` (a python keyword); code spells `provider=`.
    yaml_side = EnvVar.model_validate({"from": "aws-sm", "ref": "prod/agent"})
    code_side = EnvVar(provider="aws-sm", ref="prod/agent")
    assert yaml_side == code_side
    assert yaml_side.provider == "aws-sm"


def test_managed_defaults():
    entry = EnvVar.model_validate({"from": "env"})
    assert entry.ref == ""
    assert entry.key is None
    assert entry.fetch == "lazy"


def test_value_and_from_are_mutually_exclusive():
    with pytest.raises(ValidationError, match="not both"):
        EnvVar.model_validate({"value": "x", "from": "env"})


def test_one_of_value_or_from_is_required():
    with pytest.raises(ValidationError, match="'value' or 'from'"):
        EnvVar()


def test_readonly_on_a_managed_entry_is_refused():
    # A readonly managed variable would print `-r` beside a value that
    # changes under refresh, which is a lie.
    with pytest.raises(ValidationError, match="readonly"):
        EnvVar.model_validate({"from": "env", "readonly": True})


def test_unexporting_a_managed_entry_is_refused():
    with pytest.raises(ValidationError, match="export"):
        EnvVar.model_validate({"from": "env", "export": False})


@pytest.mark.parametrize("extra", [
    {
        "ref": "prod/agent"
    },
    {
        "key": "TOKEN"
    },
    {
        "fetch": "eager"
    },
])
def test_managed_keys_on_a_literal_entry_are_refused(extra):
    with pytest.raises(ValidationError, match="managed entries"):
        EnvVar.model_validate({"value": "x", **extra})


def test_unknown_keys_are_refused():
    with pytest.raises(ValidationError):
        EnvVar.model_validate({"value": "x", "sticky": True})


def test_entry_is_frozen():
    entry = EnvVar(value="x")
    with pytest.raises(ValidationError):
        entry.value = "y"  # type: ignore[misc]
