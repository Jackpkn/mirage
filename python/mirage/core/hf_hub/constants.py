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

API_BASE = "https://huggingface.co"

# The Hub's default branch. Unlike GitHub, where the default is per
# repository and costs a request to learn, every Hub repo is created with
# `main` and the API offers no way to change it, so an unpinned mount
# resolves without a round trip.
DEFAULT_REVISION = "main"

SCOPE_ERROR = 5000

# The tree endpoint's page size, and the reason there are two of them.
# A bare listing serves up to 1000 rows a page. Asking for `expand=true`
# -- the only way to learn the commit that last touched each path, which
# is a Hub file's only mtime -- drops the server's own page to 50 and
# refuses any limit above 100 ("Invalid limit for index tree pagination").
# A 100k-file dataset is therefore ~100 requests bare and ~2000 expanded
# against a budget the Hub advertises as 500 calls / 300s, which is why
# expansion is opt-in per mount rather than the default.
TREE_PAGE_SIZE = 1000
TREE_PAGE_SIZE_EXPANDED = 100

# How many hops of `Link: rel="next"` a tree walk will follow. A repo of
# 100k files is 100 pages; the ceiling exists so a server that answers a
# self-referential cursor cannot spin forever.
MAX_TREE_PAGES = 1000

# The URL segment each repo type is addressed by under /api/. Both the
# API and the resolve host spell the plural, and this is also the
# `{repo_type}s` the commit and preupload endpoints interpolate.
API_SEGMENTS = {
    "model": "models",
    "dataset": "datasets",
    "space": "spaces",
}

# The segment the *content* host spells, which is not the same table: a
# model's files hang off the bare repo id (huggingface.co/gpt2/resolve/...)
# while a dataset's and a space's sit under their own segment. Reusing
# API_SEGMENTS here 404s every model read.
RESOLVE_SEGMENTS = {
    "model": "",
    "dataset": "datasets",
    "space": "spaces",
}

# How much of a file the preupload probe sends so the Hub can decide
# regular-vs-LFS. huggingface_hub sends the same 512 bytes.
PREUPLOAD_SAMPLE_BYTES = 512

# Statuses worth another attempt. 429 is the documented rate limit (the
# Hub advertises 500 API calls / 300s and 3000 resolves / 300s in
# `ratelimit` headers) and the 5xx family is transient by definition.
# The Hub answers a create for a repository that already exists with
# this, which is what --exist-ok turns back into success.
HTTP_CONFLICT = 409

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_RETRIES = 3

# How much a streaming read pulls per chunk.
DEFAULT_CHUNK_SIZE = 1024 * 1024

# How many files one preupload probe asks about. huggingface_hub chunks
# at the same 256.
COMMIT_CHUNK = 256

# What a commit says when the caller had nothing to say. The Hub requires
# a non-empty summary, and a write reaching the backend through `cp` or a
# redirect has no message of its own to offer.
# Upstream's own default for `hf download --max-workers`. The bound is
# what matters: the Hub rate-limits its resolvers at 3000 per 300s, so a
# repository of many small files must not fan out without one.
MAX_DOWNLOAD_WORKERS = 8

# Upstream's separator for the flat per-repository cache directory
# (constants.REPO_ID_SEPARATOR): "models--julien-c--EsperBERTo-small".
REPO_ID_SEPARATOR = "--"

# What makes a word a pattern rather than a filename. Used to tell an
# upstream-style variadic --include line from a real filename operand.
GLOB_CHARS = ("*", "?", "[")

DEFAULT_COMMIT_MESSAGE = "Update from mirage"

# How long a seeded listing stays live. The index holds the whole tree
# rather than a cache in front of it, so this is how often the Hub is
# re-walked, not how stale one row may get.
INDEX_TTL = 86_400
