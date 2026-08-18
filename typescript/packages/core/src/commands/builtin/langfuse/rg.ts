// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { LangfuseAccessor } from '../../../accessor/langfuse.ts'
import type { IndexCacheStore } from '../../../cache/index/index.ts'
import {
  fetchDatasets,
  fetchPrompts,
  fetchSessions,
  fetchTraces,
} from '../../../core/langfuse/client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { LANGFUSE_IO } from './io.ts'
import { read as langfuseRead } from '../../../core/langfuse/read.ts'
import { readdir as langfuseReaddir } from '../../../core/langfuse/readdir.ts'
import { SEARCH_KINDS, detectScope } from '../../../core/langfuse/scope.ts'
import { stat as langfuseStat } from '../../../core/langfuse/stat.ts'
import { type FileStat, ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { rgGeneric } from '../generic/rg.ts'
import { compilePattern, patternArg } from '../grep_helper.ts'
import { filterDatasets, filterPrompts, filterSessions, filterTraces } from './grep.ts'
import { FlagView } from '../../spec/types.ts'

const resolveLangfuseGlob = resolveGlobOf(LANGFUSE_IO)

async function* langfuseStream(
  accessor: LangfuseAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
): AsyncIterable<Uint8Array> {
  yield await langfuseRead(accessor, p, index)
}

async function rgCommand(
  accessor: LangfuseAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const limit = accessor.config.defaultSearchLimit ?? 50

  const first = paths[0]
  if (first !== undefined && pattern !== null && !pattern.includes('\n')) {
    const search = SEARCH_KINDS[detectScope(first).kind]
    const fl = new FlagView(opts.flags, specOf('rg'))
    const pat = compilePattern(pattern, fl.asBool('i'), fl.asBool('F'), fl.asBool('w'))
    if (search === 'traces') {
      const traces = await fetchTraces(accessor.transport, { limit })
      return filterTraces(traces, pat)
    }
    if (search === 'sessions') {
      const sessions = await fetchSessions(accessor.transport, { limit })
      return filterSessions(sessions, pat)
    }
    if (search === 'prompts') {
      const prompts = await fetchPrompts(accessor.transport)
      return filterPrompts(prompts, pat)
    }
    if (search === 'datasets') {
      const datasets = await fetchDatasets(accessor.transport)
      return filterDatasets(datasets, pat)
    }
  }

  const resolved =
    paths.length > 0 ? await resolveLangfuseGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> =>
    langfuseStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    langfuseReaddir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    langfuseStream(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, stream)
}

export const LANGFUSE_RG = command({
  name: 'rg',
  resource: ResourceName.LANGFUSE,
  spec: specOf('rg'),
  fn: rgCommand,
})
