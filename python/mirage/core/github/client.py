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

import json
from typing import Any

import aiohttp
from pydantic import SecretStr

from mirage.core.api.client import api_request, status_error
from mirage.core.github.constants import API_BASE, API_VERSION
from mirage.resource.secrets import reveal_secret
from mirage.types import JsonValue


def github_headers(token: SecretStr) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(token)}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
    }


def github_url(path: str, base_url: str | None = None, **kwargs: str) -> str:
    return (base_url or API_BASE) + path.format(**kwargs)


class GitHubApiError(Exception):
    """A GitHub call that answered with a status the caller cannot use.

    Args:
        message (str): what GitHub said, its own wording where it gave one.
        status (int): the HTTP status.
    """

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


async def github_get(token: SecretStr,
                     path: str,
                     params: dict[str, Any] | None = None,
                     *,
                     base_url: str | None = None,
                     **kwargs: str) -> dict[str, Any]:
    url = github_url(path, base_url, **kwargs)
    data: dict[str, Any] = await api_request("GET",
                                             url,
                                             error_of=status_error,
                                             headers=github_headers(token),
                                             params=params)
    return data


async def github_request(token: SecretStr,
                         method: str,
                         path: str,
                         body: "JsonValue | None" = None,
                         params: dict[str, str] | None = None,
                         *,
                         base_url: str | None = None) -> "JsonValue":
    """One arbitrary API call, the shape `gh api` needs.

    A GET carries its fields in the query string and every other method in
    a JSON body, which is gh's own rule; a call with neither sends no body
    at all, so a bare DELETE stays a bare DELETE rather than an empty JSON
    object. The path is used verbatim, never format-expanded, because it
    arrives from a command line and may hold braces of its own.

    Args:
        token (SecretStr): the API token.
        method (str): the HTTP method.
        path (str): the endpoint path, leading slash included.
        body (JsonValue | None): the JSON body, None to send none.
        params (dict[str, str] | None): query parameters.
        base_url (str | None): API base, defaulting to github.com's.

    Returns:
        JsonValue: the decoded body, None for an empty one.

    Raises:
        GitHubApiError: the call answered with a non-2xx status.
    """
    url = (base_url or API_BASE) + path
    data: JsonValue = await api_request(method.upper(),
                                        url,
                                        error_of=_error_of,
                                        headers=github_headers(token),
                                        params=params,
                                        json_body=body)
    return data


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    return GitHubApiError(_api_message(text, resp.reason), resp.status)


def _api_message(text: str, reason: str | None) -> str:
    """GitHub's own wording for a failure, or the status reason.

    Args:
        text (str): the response body.
        reason (str | None): the HTTP reason phrase.

    Returns:
        str: the message to report.
    """
    try:
        payload = json.loads(text)
    except ValueError:
        return reason or text
    if isinstance(payload, dict):
        message = payload.get("message")
        if isinstance(message, str):
            return message
    return reason or text
