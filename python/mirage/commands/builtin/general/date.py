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

import email.utils
from datetime import datetime, timezone

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandName, FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.dates import parse_date_expr


def _expand_gnu_only(fmt: str, dt: datetime) -> str:
    """Expand the directives GNU date implements itself, ahead of strftime.

    ``%q`` (quarter) exists in no C library strftime, so passing it
    through prints a mangled literal; GNU expands it before formatting
    and so does this. ``%%`` pairs are stepped over, keeping ``%%q``
    literal.

    Args:
        fmt (str): the + format as typed.
        dt (datetime): the moment being rendered.
    """
    out: list[str] = []
    i = 0
    while i < len(fmt):
        if fmt[i] == "%" and i + 1 < len(fmt):
            nxt = fmt[i + 1]
            if nxt == "q":
                out.append(str((dt.month - 1) // 3 + 1))
            else:
                out.append(fmt[i:i + 2])
            i += 2
            continue
        out.append(fmt[i])
        i += 1
    return "".join(out)


@command("date", resource=None, spec=SPECS["date"], provision=pure_provision)
async def date(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["date"])
    u = fl.as_bool("u")
    d = fl.as_str("d")
    if len(texts) > 1:
        raise extra_operand_error(CommandName.DATE, texts[1])
    if d is not None:
        parsed_d = parse_date_expr(d, utc=u)
        if parsed_d is None:
            # GNU's refusal, exit 1: a wrong answer with exit 0 poisons
            # whatever consumed it (the NaN-timestamp corpus failure).
            return None, IOResult(
                exit_code=1, stderr=f"date: invalid date '{d}'\n".encode())
        dt = parsed_d
    elif u:
        dt = datetime.now(timezone.utc)
    else:
        dt = datetime.now()
    fmt: str | None = None
    for t in texts:
        if t.startswith("+"):
            fmt = t[1:]
            break
    if fl.as_bool("args_I"):
        result = dt.strftime("%Y-%m-%d")
    elif fl.as_bool("R"):
        result = email.utils.format_datetime(dt)
    elif fmt is not None:
        result = dt.strftime(_expand_gnu_only(fmt, dt))
    else:
        result = dt.strftime("%a %b %d %H:%M:%S %Z %Y") if u else dt.strftime(
            "%a %b %d %H:%M:%S %Y")
    return (result + "\n").encode(), IOResult()
