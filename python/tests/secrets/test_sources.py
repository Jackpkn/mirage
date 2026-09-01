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
from pydantic import BaseModel, ConfigDict, SecretStr

from mirage.secrets import registry
from mirage.secrets.config import DotenvConfig, SourceBlock
from mirage.secrets.dotenv import fetch_dotenv
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.sources import config_value, resolve_sources
from mirage.secrets.types import ResolvedSecret


class DemoConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    account: str = "default"
    token: SecretStr | None = None


async def fetch_demo(config: DemoConfig, ref: str) -> ResolvedSecret:
    seen = config.token.get_secret_value() if config.token else "none"
    return ResolvedSecret(fields={"credential": f"{config.account}:{seen}"})


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})
    register_secrets("demo", DemoConfig, fetch_demo)


def block(**config) -> SourceBlock:
    return SourceBlock.model_validate({"source": "demo", "config": config})


@pytest.mark.asyncio
async def test_a_literal_config_reaches_the_source():
    built = await resolve_sources({"prod": block(account="acct")})
    secret = await built["prod"].fetch(built["prod"].config, "r")
    assert secret.fields["credential"] == "acct:none"


@pytest.mark.asyncio
async def test_a_pointer_config_reads_its_bootstrap_source(monkeypatch):
    monkeypatch.setenv("SOURCES_PROBE", "s3cr3t")
    built = await resolve_sources(
        {"prod": block(token={
            "from": "env",
            "key": "SOURCES_PROBE"
        })})
    secret = await built["prod"].fetch(built["prod"].config, "r")
    assert secret.fields["credential"] == "default:s3cr3t"


@pytest.mark.asyncio
async def test_two_instances_of_one_source_keep_their_own_config():
    built = await resolve_sources({
        "prod": block(account="acct-prod"),
        "test": block(account="acct-test"),
    })
    prod = await built["prod"].fetch(built["prod"].config, "r")
    test = await built["test"].fetch(built["test"].config, "r")
    assert prod.fields["credential"] == "acct-prod:none"
    assert test.fields["credential"] == "acct-test:none"


@pytest.mark.asyncio
async def test_an_empty_table_resolves_to_nothing():
    assert await resolve_sources({}) == {}


@pytest.mark.asyncio
async def test_a_missing_bootstrap_field_names_the_field(monkeypatch):
    monkeypatch.delenv("SOURCES_ABSENT", raising=False)
    with pytest.raises(SecretsError) as caught:
        await resolve_sources(
            {"prod": block(token={
                "from": "env",
                "key": "SOURCES_ABSENT"
            })})
    assert "secrets.prod.config.token" in str(caught.value)
    assert "SOURCES_ABSENT" in str(caught.value)


@pytest.mark.asyncio
async def test_an_unknown_source_names_the_known_ones():
    with pytest.raises(SecretsError) as caught:
        await resolve_sources({"prod": SourceBlock(source="nope", config={})})
    assert "unknown secrets source 'nope'" in str(caught.value)


@pytest.mark.asyncio
async def test_config_the_source_refuses_reports_field_and_reason():
    with pytest.raises(SecretsError) as caught:
        await resolve_sources({"prod": block(nonesuch="x")})
    assert "secrets.prod:" in str(caught.value)
    assert "nonesuch" in str(caught.value)


@pytest.mark.asyncio
async def test_a_refusal_never_carries_the_value(monkeypatch):
    monkeypatch.setenv("SOURCES_PROBE", "s3cr3t")
    with pytest.raises(SecretsError) as caught:
        await resolve_sources({
            "prod":
            block(account={
                "from": "env",
                "key": "SOURCES_PROBE"
            },
                  nonesuch="x")
        })
    assert "s3cr3t" not in str(caught.value)


@pytest.mark.asyncio
async def test_config_value_reads_one_field(monkeypatch):
    monkeypatch.setenv("SOURCES_PROBE", "v")
    ref = block(token={"from": "env", "key": "SOURCES_PROBE"}).config["token"]
    assert await config_value("prod", "token", ref) == "v"


@pytest.mark.asyncio
async def test_a_failed_bootstrap_fetch_is_redacted(monkeypatch):
    """The dotenv source renders the host path it looked for, and the
    executor folds this straight onto the agent's stderr, so the words
    the source chose must not survive the boundary."""
    register_secrets("dotenv", DotenvConfig, fetch_dotenv)
    with pytest.raises(SecretsError) as err:
        await resolve_sources({
            "prod":
            SourceBlock.model_validate({
                "source": "demo",
                "config": {
                    "token": {
                        "from": "dotenv",
                        "ref": "/host/only/.env",
                        "key": "TOKEN",
                    },
                },
            })
        })
    message = str(err.value)
    assert message == "secrets.prod.config.token: cannot fetch from dotenv"
    assert "/host/only/.env" not in message


@pytest.mark.asyncio
async def test_an_instance_may_be_named_after_a_dunder():
    """Free in python; the TypeScript twin has to build its table with
    Object.fromEntries, since a keyed literal assigns `__proto__`
    through the prototype setter and leaves no own entry."""
    built = await resolve_sources({"__proto__": block(account="weird")})
    assert set(built) == {"__proto__"}
    secret = await built["__proto__"].fetch(built["__proto__"].config, "")
    assert secret.fields == {"credential": "weird:none"}
