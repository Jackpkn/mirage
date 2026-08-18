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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 has_search_shaping_flags,
                                                 pattern_arg)
from mirage.commands.builtin.langfuse.grep import (_filter_traces,
                                                   _format_dataset_results,
                                                   _format_prompt_results,
                                                   _format_session_results)
from mirage.commands.builtin.langfuse.io import resolve_glob
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.langfuse.client import (fetch_datasets, fetch_prompts,
                                         fetch_sessions, fetch_traces)
from mirage.core.langfuse.read import read as langfuse_read
from mirage.core.langfuse.readdir import readdir as _readdir
from mirage.core.langfuse.scope import SEARCH_KINDS, detect_scope
from mirage.core.langfuse.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="langfuse", spec=SPECS["rg"])
async def rg(accessor: LangfuseAccessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")
    i = fl.as_bool("i")
    w = fl.as_bool("w")
    F = fl.as_bool("F")
    pat = compile_pattern(pattern_str, i, F, w)

    config = accessor.config
    limit = config.default_search_limit

    # The search push-down answers from the list endpoints (one call instead
    # of one read per entry), so it greps listing summaries: a pattern that
    # only occurs in a trace's observation bodies needs a file read to match.
    # Output/match-shaping flags defer to the generic scan below.
    if (paths and not has_unresolved_glob(paths) and "\n" not in pattern_str
            and not has_search_shaping_flags(opts.flags)):
        search = SEARCH_KINDS.get(detect_scope(paths[0]).kind)

        if search == "traces":
            traces = await fetch_traces(
                accessor.api,
                limit=limit,
            )
            return _filter_traces(traces, pat)

        if search == "sessions":
            sessions = await fetch_sessions(
                accessor.api,
                limit=limit,
            )
            return _format_session_results(sessions, pat)

        if search == "prompts":
            prompts = await fetch_prompts(accessor.api)
            return _format_prompt_results(prompts, pat)

        if search == "datasets":
            datasets = await fetch_datasets(accessor.api)
            return _format_dataset_results(datasets, pat)

    resolved = await resolve_glob(accessor, paths,
                                  index=opts.index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        opts.flags,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(langfuse_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
