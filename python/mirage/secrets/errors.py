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

from collections.abc import Mapping

# Past this many, what came back is not a secret's shape: the `env`
# source answers with the whole process environment, and reciting a
# host's variable names back to the agent is neither a useful hint nor
# ours to print.
MAX_LISTED_FIELDS = 12

# Sources whose fields are the host's shape rather than a secret's,
# and are never named back however few of them there are: a hardened
# container starts from `env -i` plus a handful of credentials, so a
# count threshold alone would recite exactly the environment worth
# hiding.
OPAQUE_FIELD_SOURCES = frozenset({"env"})


def field_summary(fields: Mapping[str, str], source: str) -> str:
    """How a refusal names the fields the secret did carry.

    Lives beside the error it words because both the config plane and
    the env plane raise it, from different packages.

    Args:
        fields (Mapping[str, str]): the fetched secret's fields.
        source (str): the source they came from.

    Returns:
        str: what follows "has" in the message -- the labels for a
            secret of ordinary size, a bare count for the process
            environment or for anything big enough to be one.
    """
    if source in OPAQUE_FIELD_SOURCES or len(fields) > MAX_LISTED_FIELDS:
        return f"{len(fields)} fields"
    return "{" + ", ".join(sorted(fields)) + "}"


class SecretsError(Exception):
    """A secrets source could not answer, or was addressed wrongly.

    One type for the whole package: fetch failures, malformed refs and
    registry misses all speak it with distinct messages. These are
    host-plane errors in mirage's config voice; the agent plane only
    ever sees one as a failed command's stderr naming the variable and
    the source it needed.
    """
