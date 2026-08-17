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
import math
from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial
from typing import Any, Literal

import aiohttp
from tenacity import (AsyncRetrying, RetryCallState, retry_if_exception_type,
                      stop_after_attempt)

from mirage.types import ErrorOf, JsonValue


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


class _RetryableStatus(Exception):
    """A response whose status the policy retries, carried to tenacity.

    The body is read inside the attempt because the wait callback is
    synchronous and cannot await it; the response object stays readable
    for headers, status and request info after its connection returns to
    the pool.
    """

    def __init__(self, resp: aiohttp.ClientResponse, text: str) -> None:
        super().__init__(f"retryable HTTP {resp.status}")
        self.resp = resp
        self.text = text


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


def _usable_delay(value: float) -> bool:
    """Whether a server-supplied delay is one we can actually wait out.

    NaN and infinity both park the retry forever (``asyncio.sleep`` never
    wakes from either), and a negative delay is malformed per RFC 9110, so
    all three are as unusable as a header that does not parse at all.

    Args:
        value (float): the delay the server asked for, in seconds.
    """
    return math.isfinite(value) and value >= 0.0


def _header_delay(resp: aiohttp.ClientResponse, attempt: int,
                  retry: RetryPolicy) -> float:
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            # malformed Retry-After header: fall back to exponential backoff
            delay = math.nan
        if _usable_delay(delay):
            return delay
    return min(2.0**attempt, retry.max_backoff)


def _body_delay(text: str) -> float:
    try:
        data = json.loads(text)
    except ValueError:
        return 1.0
    if isinstance(data, dict):
        value = data.get("retry_after")
        # json.loads accepts NaN/Infinity literals, and 1e999 overflows to
        # inf, so a body delay needs the same guard as a header one.
        if isinstance(value, (int, float)) and _usable_delay(float(value)):
            return float(value)
    return 1.0


def _retry_delay(retry_state: RetryCallState, retry: RetryPolicy) -> float:
    outcome = retry_state.outcome
    error = outcome.exception() if outcome is not None else None
    if not isinstance(error, _RetryableStatus):
        return 1.0
    if retry.delay_source == "body":
        return _body_delay(error.text)
    return _header_delay(error.resp, retry_state.attempt_number - 1, retry)


async def _attempt(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    error_of: ErrorOf,
    headers: Mapping[str, str] | None,
    params: Mapping[str, Any] | None,
    json_body: JsonValue,
    retry: RetryPolicy,
    read: Literal["json", "none"],
) -> Any:
    async with session.request(method,
                               url,
                               headers=headers,
                               params=params,
                               json=json_body) as resp:
        if resp.status in retry.statuses:
            raise _RetryableStatus(resp, await resp.text())
        if resp.status >= 400:
            raise error_of(resp, await resp.text())
        if read == "none":
            return None
        return await resp.json()


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
    retrying = AsyncRetrying(
        sleep=asyncio.sleep,
        stop=stop_after_attempt(retry.max_retries + 1),
        wait=partial(_retry_delay, retry=retry),
        retry=retry_if_exception_type(_RetryableStatus),
        reraise=True,
    )
    async with aiohttp.ClientSession() as session:
        try:
            return await retrying(_attempt, session, method, url, error_of,
                                  headers, params, json_body, retry, read)
        except _RetryableStatus as exhausted:
            # retries ran dry: the final retryable response maps through
            # the same hook a plain error status does
            raise error_of(exhausted.resp, exhausted.text) from None
