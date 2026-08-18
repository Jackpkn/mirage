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
import math

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.builtins.shared import Result
from mirage.workspace.executor.builtins.sleep.constants import SLEEP_INTERVAL
from mirage.workspace.executor.builtins.types import BuiltinCall
from mirage.workspace.types import ExecutionNode


async def handle_sleep(
    args: list[str],
    cancel: asyncio.Event | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        err = b"sleep: missing operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    raw = args[0]
    # "1e309" passes the regex but overflows to inf, so check both.
    seconds = float(raw) if SLEEP_INTERVAL.fullmatch(raw) else math.inf
    if not math.isfinite(seconds):
        err = f"sleep: invalid time interval '{raw}'\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    await cancellable_sleep(seconds, cancel)
    return None, IOResult(), ExecutionNode(command="sleep", exit_code=0)


async def sleep_builtin(call: BuiltinCall) -> Result:
    """The ``sleep`` arm.

    Args:
        call (BuiltinCall): the invocation; its cancel event ends the
            wait early.
    """
    return await handle_sleep(list(call.argv.args), cancel=call.cancel)
