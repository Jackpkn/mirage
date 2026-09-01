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

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from mirage.secrets.config import SecretRef, SourceBlock
from mirage.secrets.errors import SecretsError, field_summary
from mirage.secrets.registry import fetch_secret, source_for
from mirage.secrets.types import ResolvedSource


async def config_value(name: str, field: str, ref: SecretRef) -> str:
    """Read one source-config value from its bootstrap source.

    Args:
        name (str): the instance being built, for the error.
        field (str): the config field being filled, for the error.
        ref (SecretRef): the pointer the field declared.

    Raises:
        SecretsError: the bootstrap source has no such field. The
            wording names the field wanted and the labels present,
            never a value, the same way the env plane's fill does.
    """
    secret = await fetch_secret(ref.provider, ref.ref)
    value = secret.fields.get(ref.key)
    if value is None:
        raise SecretsError(f"secrets.{name}.config.{field}: wanted field "
                           f"{ref.key!r}, the {ref.provider} secret has "
                           f"{field_summary(secret.fields)}")
    return value


async def resolve_sources(
        blocks: Mapping[str, SourceBlock]) -> dict[str, ResolvedSource]:
    """Build every declared instance, reading its pointers.

    Runs once per workspace, before the first fetch, and reaches only
    bootstrap sources -- the process env and dotenv files -- so a
    declaration this cannot satisfy is a config error and fails every
    line, while a source that is merely unreachable still fails only
    the names that want it.

    Args:
        blocks (Mapping[str, SourceBlock]): the `secrets:` block,
            instance name -> declaration.

    Raises:
        SecretsError: an unknown source, a missing bootstrap field, or
            config the source's own model refuses. A refusal is
            reported by field and reason only; the values are never in
            the message.
    """
    out: dict[str, ResolvedSource] = {}
    for name, block in blocks.items():
        config_model, fetch = source_for(block.source)
        values: dict[str, Any] = {}
        for field, value in block.config.items():
            values[field] = (await config_value(name, field, value)
                             if isinstance(value, SecretRef) else value)
        try:
            config = config_model.model_validate(values)
        except ValidationError as exc:
            detail = "; ".join(
                f"{'.'.join(str(part) for part in err['loc'])}: {err['msg']}"
                for err in exc.errors())
            raise SecretsError(f"secrets.{name}: {detail}") from exc
        out[name] = ResolvedSource(config, fetch)
    return out
