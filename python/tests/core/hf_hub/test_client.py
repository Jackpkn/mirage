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

from unittest.mock import MagicMock

import pytest
from pydantic import SecretStr

from mirage.core.hf_hub.client import (HfHubError, _error_of, api_url,
                                       hub_headers, resolve_url, rev_segment)


def test_hub_headers_omit_authorization_without_a_token():
    assert hub_headers(None) == {"Accept": "application/json"}


def test_hub_headers_carry_a_bearer_token():
    headers = hub_headers(SecretStr("tok"))
    assert headers["Authorization"] == "Bearer tok"


@pytest.mark.parametrize("repo_type,expected", [
    ("model", "https://huggingface.co/api/models/a/b/refs"),
    ("dataset", "https://huggingface.co/api/datasets/a/b/refs"),
    ("space", "https://huggingface.co/api/spaces/a/b/refs"),
])
def test_api_url_pluralizes_every_repo_type(repo_type, expected):
    assert api_url("https://huggingface.co", repo_type, "a/b",
                   "/refs") == expected


@pytest.mark.parametrize("repo_type,expected", [
    ("model", "https://huggingface.co/a/b/resolve/main/f.json"),
    ("dataset", "https://huggingface.co/datasets/a/b/resolve/main/f.json"),
    ("space", "https://huggingface.co/spaces/a/b/resolve/main/f.json"),
])
def test_resolve_url_puts_a_model_at_the_bare_repo_id(repo_type, expected):
    """The content host is not the API host's table.

    A model's files hang off the bare repo id while a dataset's and a
    space's sit under their own segment, so reusing the API's plural
    here would 404 every model read.
    """
    assert resolve_url("https://huggingface.co", repo_type, "a/b", "main",
                       "f.json") == expected


def test_resolve_url_percent_encodes_the_path():
    url = resolve_url("https://huggingface.co", "model", "a/b", "main",
                      "dir/a file#1.txt")
    assert url.endswith("/resolve/main/dir/a%20file%231.txt")


def test_resolve_url_keeps_slashes_between_segments():
    url = resolve_url("https://huggingface.co", "model", "a/b", "main",
                      "deep/nested/f.txt")
    assert url.endswith("/resolve/main/deep/nested/f.txt")


def test_error_of_prefers_the_hub_error_header():
    resp = MagicMock(status=404, reason="Not Found")
    resp.headers = {"X-Error-Message": "Entry not found"}
    err = _error_of(resp, '{"error":"whatever"}')
    assert isinstance(err, HfHubError)
    assert str(err) == "Entry not found"
    assert err.status == 404


def test_error_of_falls_back_to_the_body():
    resp = MagicMock(status=500, reason="Server Error")
    resp.headers = {}
    err = _error_of(resp, "  boom  ")
    assert str(err) == "boom"
    assert err.status == 500


def test_rev_segment_encodes_a_slash():
    """A git ref may hold a slash, and every Hub route reads the segment
    after the verb as the whole revision, so an unencoded one splits."""
    assert rev_segment("feature/foo") == "feature%2Ffoo"
    assert rev_segment("refs/pr/1") == "refs%2Fpr%2F1"


def test_rev_segment_leaves_an_ordinary_ref_alone():
    assert rev_segment("main") == "main"
    assert rev_segment("v1.0.0-rc.1") == "v1.0.0-rc.1"
