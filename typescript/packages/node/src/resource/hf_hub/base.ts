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

import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseResource } from '@struktoai/mirage-core/resource/base'
import type { Resource, ResourceStateBase } from '@struktoai/mirage-core/resource/base'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { DeltaHook } from '@struktoai/mirage-core/watch/index'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { HF_HUB_COMMANDS } from '../../commands/builtin/hf_hub/index.ts'
import { SCOPE_ERROR } from '../../core/hf_hub/constants.ts'
import { create as createCore } from '../../core/hf_hub/create.ts'
import { exists as existsCore } from '../../core/hf_hub/exists.ts'
import { mkdir as mkdirCore } from '../../core/hf_hub/mkdir.ts'
import { read as readCore } from '../../core/hf_hub/read.ts'
import { readdir as readdirCore } from '../../core/hf_hub/readdir.ts'
import { rmR as rmRCore } from '../../core/hf_hub/rm.ts'
import { stat as statCore } from '../../core/hf_hub/stat.ts'
import { rangeRead as rangeReadCore, stream as streamCore } from '../../core/hf_hub/stream.ts'
import { unlink as unlinkCore } from '../../core/hf_hub/unlink.ts'
import { buildDeltaHook } from '../../core/hf_hub/watch.ts'
import { write as writeCore } from '../../core/hf_hub/write.ts'
import { HF_HUB_OPS } from '../../ops/hf_hub/index.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

/**
 * The shared body of the three Hub *repository* resources.
 *
 * Separate from `HfResource` (resource/hf_buckets/base.ts) on purpose: that
 * one drives OpenDAL against Hugging Face Buckets, which is a different
 * product -- Xet-backed mutable object storage with no commits and no
 * revisions. These three are git repositories, read through the Hub's own
 * tree API and written as commits.
 *
 * Python has no twin of this file: its three resources each spell their own
 * body, the way its four hf resources always have. The asymmetry is recorded
 * in spec/layout_exceptions.json.
 */
export abstract class HfHubResource extends BaseResource implements Resource {
  abstract readonly prompt: string
  abstract readonly accessor: HfHubAccessor
  // Abstract for the same reason the bucket base narrows it: all three carry
  // a config and so owe their own redaction, and inheriting BaseResource's
  // bare `{type}` would drop it and read back as an empty mount.
  abstract override getState(): Promise<ResourceStateBase>
  readonly cachesReads: boolean = true
  // The Hub tree reports every file's exact byte size, and for an LFS file
  // that is the object's own size rather than the pointer's, so no read can
  // be short.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot: boolean = true
  // The index is not a cache in front of a listing, it IS the listing: one
  // recursive fetch seeds it whole. A long TTL therefore spares the Hub a
  // full re-walk rather than risking a stale row.
  override readonly indexTtl: number = 86_400
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCore,
    readdir: readdirCore,
    stat: statCore,
    read_stream: streamCore,
    range_read: rangeReadCore,
    exists: existsCore,
    write: writeCore,
    create: createCore,
    unlink: unlinkCore,
    rm_r: rmRCore,
    mkdir: mkdirCore,
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return HF_HUB_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return HF_HUB_OPS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p, this.index)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, p, this.index)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p, this.index)
  }

  exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p, this.index)
  }

  mkdir(p: PathSpec): Promise<void> {
    return mkdirCore(this.accessor, p)
  }

  unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p, this.index)
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.resourcePath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                resourcePath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  override loadState(_state: unknown): Promise<void> {
    return Promise.resolve()
  }
}
