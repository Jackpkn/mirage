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

import re
from collections.abc import Callable
from dataclasses import dataclass

_ASCII_DIGITS = re.compile(r"^[0-9]+$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def iso_date_shaped(text: str) -> bool:
    """Whether the text is shaped like a YYYY-MM-DD date.

    Shape only, not a calendar check: the dated-message backends mint
    their date directories from real timestamps, so a shaped-but-absent
    date resolves through the listing like any other name. A backend
    that must refuse impossible dates (gcal, whose day dirs exist by
    construction) validates with its own calendar-aware check instead.

    Args:
        text (str): decoded segment payload.
    """
    return _ISO_DATE.match(text) is not None


def ascii_digits(text: str) -> bool:
    """Whether the text is a plain ASCII integer.

    ``int()`` also accepts unicode digits and TS ``parseInt`` accepts a
    digit-prefixed tail, so this is the one spelling both languages can
    agree on for numeric path segments.

    Args:
        text (str): decoded segment payload.
    """
    return _ASCII_DIGITS.match(text) is not None


@dataclass(frozen=True, slots=True)
class Codec:
    """How one dynamic path segment encodes its value.

    Args:
        suffix (str): extension the segment carries (".json"); empty for
            bare names.
        validate (Callable | None): extra shape check on the decoded
            payload; a failing payload means the segment does not match
            the scope at all.
    """
    suffix: str = ""
    validate: Callable[[str], bool] | None = None

    def decode(self, text: str) -> str | None:
        """Decode a path segment, None when it does not fit.

        Args:
            text (str): raw path segment.
        """
        if self.suffix:
            if not text.endswith(self.suffix):
                return None
            text = text[:-len(self.suffix)]
        if not text:
            return None
        if self.validate is not None and not self.validate(text):
            return None
        return text

    def encode(self, value: str) -> str:
        """Render a value back into a path segment.

        Args:
            value (str): decoded payload.
        """
        return f"{value}{self.suffix}"


RAW = Codec()
JSON_NAME = Codec(suffix=".json")
JSONL_NAME = Codec(suffix=".jsonl")
INT_JSON = Codec(suffix=".json", validate=ascii_digits)
DATE = Codec(validate=iso_date_shaped)
