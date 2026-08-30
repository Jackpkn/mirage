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

from pydantic import BaseModel, ConfigDict, SecretStr


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
