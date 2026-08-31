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

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator


class EnvVar(BaseModel):
    """One entry of the env map: a literal value or a managed pointer.

    The env block is one map, name -> entry. A bare string in the map
    is the literal short form and never reaches this model; a dict is
    validated through it. `value` and `from` are mutually exclusive and
    one is required: `readonly`/`export` belong to a literal entry,
    `ref`/`key`/`fetch` to a managed one.

    Args:
        value (str | None): the literal text; set = a literal entry.
        readonly (bool): literal-only; compiles to `VarAttr.READONLY`.
        export (bool): literal-only knob (default on); a managed entry
            is always exported.
        provider (str | None): registered source name; set = a managed
            entry. Spelled `from:` in YAML (python keyword), via alias.
        ref (str): the source's address for the secret.
        key (str | None): which secret field to read; default the
            variable's own name.
        fetch (Literal["lazy", "eager"]): eager joins every line's
            fetch set instead of waiting for a reference.
    """
    model_config = ConfigDict(frozen=True,
                              extra="forbid",
                              populate_by_name=True)

    value: str | None = None
    readonly: bool = False
    export: bool = True
    provider: str | None = Field(default=None, alias="from")
    ref: str = ""
    key: str | None = None
    fetch: Literal["lazy", "eager"] = "lazy"

    @model_validator(mode="after")
    def _one_kind(self) -> "EnvVar":
        if self.value is not None and self.provider is not None:
            raise ValueError("an env entry takes 'value' or 'from', not both")
        if self.value is None and self.provider is None:
            raise ValueError("an env entry needs 'value' or 'from'")
        if self.provider is not None:
            if self.readonly:
                raise ValueError(
                    "'readonly' is for literal entries; a readonly managed "
                    "variable would change under refresh")
            if not self.export:
                raise ValueError("'export' is for literal entries; a managed "
                                 "variable is always exported")
        elif self.ref or self.key is not None or self.fetch != "lazy":
            raise ValueError(
                "'ref', 'key' and 'fetch' are for managed entries ('from')")
        return self


class AWSAuth(BaseModel):
    """The five AWS credential fields every AWS-speaking config shares.

    Factored out of `S3Config` so `AWSSMConfig` does not restate them.
    Credentials are `SecretStr` so a repr or log line never leaks one.
    No `model_config` here on purpose: each subclass decides its own
    frozen/extra policy.
    """
    region: str | None = None
    aws_access_key_id: SecretStr | None = None
    aws_secret_access_key: SecretStr | None = None
    aws_session_token: SecretStr | None = None
    aws_profile: str | None = None


class AWSSMConfig(AWSAuth):
    """AWS Secrets Manager source config: the shared auth, nothing else.

    The `ref` of a managed entry is the SecretId; it rides the fetch
    call, not this config.
    """
    model_config = ConfigDict(frozen=True, extra="forbid")


class DotenvConfig(BaseModel):
    """Dotenv source config.

    Args:
        path (str): default file when a managed entry's `ref` is empty;
            a non-empty `ref` is itself the host filesystem path.
    """
    model_config = ConfigDict(frozen=True, extra="forbid")

    path: str = ".env"


class EnvConfig(BaseModel):
    """Process-environment source config: there is nothing to say.

    The host process env has no sub-address, so a managed entry using
    this source must leave `ref` empty.
    """
    model_config = ConfigDict(frozen=True, extra="forbid")
