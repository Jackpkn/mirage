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
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

import aiohttp

from mirage.types import JsonValue

ErrorOf = Callable[[aiohttp.ClientResponse, str], Exception]


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Which statuses retry and where the wait between attempts comes from.

    Args:
        statuses (frozenset[int]): response statuses worth retrying.
        max_retries (int): retries allowed after the first attempt.
        max_backoff (float): cap for the exponential-backoff fallback.
        delay_source (str): "header" reads Retry-After and falls back to
            exponential backoff (Graph's convention); "body" reads a JSON
            ``retry_after`` field and falls back to 1s (Discord's).
    """

    statuses: frozenset[int] = frozenset()
    max_retries: int = 0
    max_backoff: float = 30.0
    delay_source: Literal["header", "body"] = "header"


NO_RETRY = RetryPolicy()


def status_error(resp: aiohttp.ClientResponse) -> Exception:
    """The error ``resp.raise_for_status()`` raises, built without raising.

    Args:
        resp (aiohttp.ClientResponse): a response with status >= 400.
    """
    return aiohttp.ClientResponseError(resp.request_info,
                                       resp.history,
                                       status=resp.status,
                                       message=resp.reason or "",
                                       headers=resp.headers)


def _header_delay(resp: aiohttp.ClientResponse, attempt: int,
                  retry: RetryPolicy) -> float:
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            # malformed Retry-After header: fall back to exponential backoff
            pass
    return min(2.0**attempt, retry.max_backoff)


def _body_delay(text: str) -> float:
    try:
        data = json.loads(text)
    except ValueError:
        return 1.0
    if isinstance(data, dict):
        value = data.get("retry_after")
        if isinstance(value, (int, float)):
            return float(value)
    return 1.0


async def _retry_delay(resp: aiohttp.ClientResponse, attempt: int,
                       retry: RetryPolicy) -> float:
    if retry.delay_source == "body":
        return _body_delay(await resp.text())
    return _header_delay(resp, attempt, retry)


async def api_request(
    method: str,
    url: str,
    *,
    error_of: ErrorOf,
    headers: Mapping[str, str] | None = None,
    params: Mapping[str, Any] | None = None,
    json_body: JsonValue = None,
    retry: RetryPolicy = NO_RETRY,
    read: Literal["json", "none"] = "json",
) -> Any:
    """One round-trip against a JSON HTTP API, with retry and error mapping.

    Args:
        method (str): HTTP method.
        url (str): full request URL.
        error_of (ErrorOf): maps a >= 400 response and its body text to the
            backend's own exception; the kit never invents an error shape.
        headers (Mapping[str, str] | None): request headers, already merged
            by the caller.
        params (Mapping[str, Any] | None): query parameters.
        json_body (JsonValue): JSON request body. None sends no body, so a
            caller that means "send an empty object" passes ``{}``
            explicitly.
        retry (RetryPolicy): which statuses to retry and how long to wait.
        read (str): "json" parses the response body; "none" ignores it.
    """
    async with aiohttp.ClientSession() as session:
        attempt = 0
        while True:
            async with session.request(method,
                                       url,
                                       headers=headers,
                                       params=params,
                                       json=json_body) as resp:
                if (resp.status in retry.statuses
                        and attempt < retry.max_retries):
                    await asyncio.sleep(await
                                        _retry_delay(resp, attempt, retry))
                    attempt += 1
                    continue
                if resp.status >= 400:
                    raise error_of(resp, await resp.text())
                if read == "none":
                    return None
                return await resp.json()
