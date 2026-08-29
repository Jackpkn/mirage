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

from typing import Any

from mirage.core.hf_hub.client import hub_get
from mirage.core.hf_hub.config import HfConfig
from mirage.types import JsonValue


async def whoami(config: HfConfig) -> dict[str, Any]:
    """Who the configured token belongs to.

    Args:
        config (HfConfig): the install's configuration.

    Returns:
        dict[str, Any]: the decoded /whoami-v2 object.
    """
    url = f"{config.endpoint.rstrip('/')}/api/whoami-v2"
    data: JsonValue = await hub_get(config.token, url)
    return data if isinstance(data, dict) else {}
