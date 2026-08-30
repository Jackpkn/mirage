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
from pydantic import SecretStr, ValidationError

from mirage.accessor.s3 import S3Config
from mirage.secrets.config import AWSAuth, AWSSMConfig, DotenvConfig, EnvConfig

AUTH_KWARGS = {
    "region": "us-east-1",
    "aws_access_key_id": "AKIA",
    "aws_secret_access_key": "shh",
    "aws_session_token": "tok",
    "aws_profile": "agent",
}


def test_awsauth_fields_default_none():
    auth = AWSAuth()
    assert auth.region is None
    assert auth.aws_access_key_id is None
    assert auth.aws_secret_access_key is None
    assert auth.aws_session_token is None
    assert auth.aws_profile is None


def test_awssm_config_accepts_the_auth_kwargs_and_is_frozen():
    config = AWSSMConfig(**AUTH_KWARGS)
    assert config.region == "us-east-1"
    assert isinstance(config.aws_secret_access_key, SecretStr)
    with pytest.raises(ValidationError):
        config.region = "eu-west-1"  # type: ignore[misc]


def test_s3config_keeps_the_five_auth_fields_as_secretstr():
    # S3Config inherits AWSAuth; the credential fields must stay
    # SecretStr so reprs and logs never leak them.
    config = S3Config(bucket="b", **AUTH_KWARGS)
    assert isinstance(config, AWSAuth)
    for name in ("aws_access_key_id", "aws_secret_access_key",
                 "aws_session_token"):
        assert isinstance(getattr(config, name), SecretStr), name
    assert config.aws_profile == "agent"
    assert config.region == "us-east-1"
    assert config.bucket == "b"


def test_dotenv_config_defaults():
    assert DotenvConfig().path == ".env"


def test_env_config_is_empty_and_frozen():
    config = EnvConfig()
    assert config.model_dump() == {}
    with pytest.raises(ValidationError):
        EnvConfig(anything="x")  # type: ignore[call-arg]
