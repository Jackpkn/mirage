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

from datetime import date, timedelta


def span_to_gmail_query(start: date, end: date) -> str:
    """A Gmail date filter for a half-open range of days.

    Args:
        start (date): first day, inclusive.
        end (date): last day, exclusive.
    """
    return (f"after:{start.year}/{start.month:02d}/{start.day:02d} "
            f"before:{end.year}/{end.month:02d}/{end.day:02d}")


def date_dir_to_gmail_query(name: str) -> str | None:
    parts = name.split("-")
    if len(parts) != 3:
        return None
    if not (len(parts[0]) == 4 and len(parts[1]) == 2 and len(parts[2]) == 2):
        return None
    try:
        d = date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None
    return span_to_gmail_query(d, d + timedelta(days=1))
