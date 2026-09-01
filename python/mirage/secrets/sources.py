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

import logging
from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from mirage.secrets.config import SecretRef, SourceBlock
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import fetch_secret, source_for
from mirage.secrets.summary import field_summary
from mirage.secrets.types import ResolvedSecret, ResolvedSource

logger = logging.getLogger(__name__)


async def config_value(
        label: str,
        ref: SecretRef,
        fetched: dict[tuple[str, str], ResolvedSecret],
        sources: Mapping[str, ResolvedSource] | None = None) -> str:
    """Read one configured value from the source it points at.

    Every plane that reads a pointer comes through here: a source's own
    config (`resolve_sources`), and a mount's or a CLI's
    (`resolve_config_secrets`). `fetched` is what makes two fields of
    one secret cost one call -- share it across the values of one
    config, or a rotation landing between two fetches pins a
    mismatched pair for the workspace's life.

    Args:
        label (str): what an error calls this value, e.g.
            `secrets.prod.config.token` or
            `mounts./slack.config.token`.
        ref (SecretRef): the pointer the field declared.
        fetched (dict[tuple[str, str], ResolvedSecret]): the
            per-resolution cache, keyed by (source, ref).
        sources (Mapping[str, ResolvedSource] | None): the declared
            instances. Absent for a source's own config, which reaches
            only bootstrap sources and so has none to consult.

    Raises:
        SecretsError: the source could not answer, or has no such
            field. Both wordings name the label and the source, and
            nothing else -- the same boundary ``fill_env`` draws, and
            for the same reason: a dotenv miss renders the host path it
            looked for, and a custom source shadowing ``env`` renders
            whatever it likes. The source's own words go to the host
            log instead.
    """
    seen = fetched.get((ref.provider, ref.ref))
    if seen is not None:
        return _field(label, ref, seen, sources)
    try:
        secret = await fetch_secret(ref.provider, ref.ref, sources)
    except Exception as exc:
        logger.warning("%s: fetch from %s failed: %s", label, ref.provider,
                       exc)
        raise SecretsError(
            f"{label}: cannot fetch from {ref.provider}") from exc
    fetched[(ref.provider, ref.ref)] = secret
    return _field(label, ref, secret, sources)


def _field(label: str, ref: SecretRef, secret: ResolvedSecret,
           sources: Mapping[str, ResolvedSource] | None) -> str:
    value = secret.fields.get(ref.key)
    if value is None:
        # A declared instance is named by the deployment, so the
        # summary is told the source behind it: `{prod: {source: env}}`
        # must redact like `env`, not like an unknown name.
        declared = sources.get(ref.provider) if sources else None
        provider = declared.source if declared is not None else ref.provider
        raise SecretsError(f"{label}: wanted field {ref.key!r}, the "
                           f"{ref.provider} secret has "
                           f"{field_summary(secret.fields, provider)}")
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
    # One fetch per bootstrap secret for the whole resolution: two
    # fields of one config naming the same dotenv file must read one
    # generation of it, or a rotation between them pins a mismatched
    # pair for the workspace's life.
    fetched: dict[tuple[str, str], ResolvedSecret] = {}
    for name, block in blocks.items():
        config_model, fetch = source_for(block.source)
        values: dict[str, Any] = {}
        for field, value in block.config.items():
            values[field] = (await config_value(
                f"secrets.{name}.config.{field}", value, fetched)
                             if isinstance(value, SecretRef) else value)
        try:
            config = config_model.model_validate(values)
        except ValidationError as exc:
            logger.warning("secrets.%s: config refused: %s", name, exc)
            # The error TYPE, never pydantic's rendered message: a
            # custom source's own validator may spell the rejected
            # input, and `values` is where a fetched credential has
            # just landed. The field path and the code say what is
            # wrong; the words go to the host log.
            detail = "; ".join(
                f"{'.'.join(str(part) for part in err['loc'])}: {err['type']}"
                for err in exc.errors())
            raise SecretsError(f"secrets.{name}: {detail}") from exc
        except Exception as exc:
            # A validator that RAISES rather than returning a
            # validation error never becomes an issue list, and
            # pydantic only wraps ValueError and AssertionError. The
            # words are the validator's, over a value just fetched.
            logger.warning("secrets.%s: config validation raised: %s", name,
                           exc)
            raise SecretsError(f"secrets.{name}: config refused") from exc
        out[name] = ResolvedSource(block.source, config, fetch)
    return out


def is_config_pointer(value: Any) -> bool:
    """Whether a raw config value is a `{from, ref, key}` pointer.

    Strict: a mapping only counts when it validates as `SecretRef`,
    extra keys included, so an ordinary mapping-valued config field
    that happens to carry a `from` is left alone.

    Args:
        value (Any): whatever the config field holds.
    """
    if not isinstance(value, Mapping) or "from" not in value:
        return False
    try:
        SecretRef.model_validate(value)
    except ValueError:
        return False
    return True


async def _resolve_value(value: Any, label: str, fetched: dict[tuple[str, str],
                                                               ResolvedSecret],
                         sources: Mapping[str, ResolvedSource] | None) -> Any:
    if isinstance(value, SecretRef):
        return await config_value(label, value, fetched, sources)
    if is_config_pointer(value):
        return await config_value(label, SecretRef.model_validate(value),
                                  fetched, sources)
    if isinstance(value, Mapping):
        return {
            key: await _resolve_value(child, f"{label}.{key}", fetched,
                                      sources)
            for key, child in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [
            await _resolve_value(item, f"{label}[{i}]", fetched, sources)
            for i, item in enumerate(value)
        ]
    return value


async def resolve_config_secrets(config: Mapping[str, Any],
                                 sources: Mapping[str, ResolvedSource]
                                 | None = None,
                                 label: str = "config") -> dict[str, Any]:
    """A raw mount or CLI config with every pointer read from its source.

    The same `config_value` a source's own config goes through, over
    the config of a thing that reaches one. Resolved **before** the
    config is constructed, so a credential field stays the plain
    `SecretStr` its client already reads and no resource, accessor or
    backend learns this plane exists.

    One `fetched` cache spans the whole config, so two fields naming
    one secret cost one call and cannot straddle a rotation.

    Args:
        config (Mapping[str, Any]): the raw config, as yaml or an
            embedder wrote it.
        sources (Mapping[str, ResolvedSource] | None): the declared
            instances, already built.
        label (str): what an error calls this config, e.g.
            `mounts./slack.config`.

    Returns:
        dict[str, Any]: the config, pointers replaced by their values.

    Raises:
        SecretsError: a source could not answer, or answered without
            the wanted field.
    """
    fetched: dict[tuple[str, str], ResolvedSecret] = {}
    return {
        key: await _resolve_value(value, f"{label}.{key}", fetched, sources)
        for key, value in config.items()
    }
