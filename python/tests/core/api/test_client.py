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

import aiohttp
import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.api.client import (NO_RETRY, RetryPolicy, _body_delay,
                                    _header_delay, api_request, status_error)

TARGET = "https://api.test/v1/thing"


class _Boom(RuntimeError):

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"boom {status}")
        self.status = status
        self.body = body


def _error_of(resp: aiohttp.ClientResponse, body: str) -> Exception:
    return _Boom(resp.status, body)


def _status_error_of(resp: aiohttp.ClientResponse, body: str) -> Exception:
    return status_error(resp)


@pytest.mark.asyncio
async def test_json_read_returns_the_parsed_body():
    with aioresponses() as m:
        m.get(TARGET, payload={"ok": True})
        result = await api_request("GET", TARGET, error_of=_error_of)
    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_read_none_ignores_the_body():
    with aioresponses() as m:
        m.put(TARGET, status=204)
        result = await api_request("PUT",
                                   TARGET,
                                   error_of=_error_of,
                                   read="none")
    assert result is None


@pytest.mark.asyncio
async def test_an_error_status_maps_through_the_hook():
    with aioresponses() as m:
        m.get(TARGET, status=404, body='{"message": "nope"}')
        with pytest.raises(_Boom) as exc:
            await api_request("GET", TARGET, error_of=_error_of)
    assert exc.value.status == 404
    assert exc.value.body == '{"message": "nope"}'


@pytest.mark.asyncio
async def test_status_error_carries_the_response_status():
    with aioresponses() as m:
        m.get(TARGET, status=500, body="broken")
        with pytest.raises(aiohttp.ClientResponseError) as exc:
            await api_request("GET", TARGET, error_of=_status_error_of)
    assert exc.value.status == 500


@pytest.mark.asyncio
async def test_body_delay_retries_then_succeeds():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=2,
                        delay_source="body")
    with aioresponses() as m:
        m.get(TARGET, status=429, payload={"retry_after": 0.001})
        m.get(TARGET, payload={"ok": 1})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   retry=retry)
    assert result == {"ok": 1}


@pytest.mark.asyncio
async def test_exhausted_retries_map_through_the_hook():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=2,
                        delay_source="body")
    with aioresponses() as m:
        for _ in range(3):
            m.get(TARGET, status=429, payload={"retry_after": 0.001})
        with pytest.raises(_Boom) as exc:
            await api_request("GET", TARGET, error_of=_error_of, retry=retry)
    assert exc.value.status == 429


@pytest.mark.asyncio
async def test_header_delay_retries_on_retry_after():
    retry = RetryPolicy(statuses=frozenset({503}), max_retries=1)
    with aioresponses() as m:
        m.get(TARGET, status=503, headers={"Retry-After": "0.001"})
        m.get(TARGET, payload={"ok": 2})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   retry=retry)
    assert result == {"ok": 2}


@pytest.mark.asyncio
async def test_no_retry_by_default():
    with aioresponses() as m:
        m.get(TARGET, status=429, payload={"retry_after": 30})
        with pytest.raises(_Boom):
            await api_request("GET",
                              TARGET,
                              error_of=_error_of,
                              retry=NO_RETRY)
    # a second registered response would have been consumed by a retry
    assert len(m.requests[("GET", URL(TARGET))]) == 1


@pytest.mark.asyncio
async def test_params_reach_the_query_string():
    with aioresponses() as m:
        m.get(f"{TARGET}?a=1&b=x", payload={"ok": 3})
        result = await api_request("GET",
                                   TARGET,
                                   error_of=_error_of,
                                   params={
                                       "a": 1,
                                       "b": "x"
                                   })
    assert result == {"ok": 3}


def test_header_delay_prefers_the_header_and_caps_the_fallback():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=4.0)

    class _Resp:
        headers = {"Retry-After": "7.5"}

    assert _header_delay(_Resp(), 0, retry) == 7.5

    class _Bare:
        headers = {}

    assert _header_delay(_Bare(), 1, retry) == 2.0
    assert _header_delay(_Bare(), 6, retry) == 4.0

    class _Malformed:
        headers = {"Retry-After": "soon"}

    # malformed header falls back to exponential backoff
    assert _header_delay(_Malformed(), 0, retry) == 1.0


def test_body_delay_reads_retry_after_and_falls_back():
    assert _body_delay('{"retry_after": 2.5}') == 2.5
    assert _body_delay('{"retry_after": "soon"}') == 1.0
    assert _body_delay("not json") == 1.0
    assert _body_delay("[1, 2]") == 1.0


def test_header_delay_refuses_a_delay_it_could_never_wake_from():
    retry = RetryPolicy(statuses=frozenset({429}),
                        max_retries=8,
                        max_backoff=4.0)

    class _Resp:
        headers: dict[str, str] = {}

    # asyncio.sleep() never wakes from NaN or inf, and a negative delay
    # retries instantly: all fall back to backoff, as "soon" does.
    for value in ("NaN", "Infinity", "-Infinity", "-5"):
        _Resp.headers = {"Retry-After": value}
        assert _header_delay(_Resp(), 0, retry) == 1.0


def test_body_delay_refuses_a_delay_it_could_never_wake_from():
    # json.loads accepts these literals, and 1e999 overflows to inf.
    assert _body_delay('{"retry_after": NaN}') == 1.0
    assert _body_delay('{"retry_after": Infinity}') == 1.0
    assert _body_delay('{"retry_after": 1e999}') == 1.0
    assert _body_delay('{"retry_after": -5}') == 1.0
