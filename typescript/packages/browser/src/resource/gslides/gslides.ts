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

import { GSlidesAccessor } from '@struktoai/mirage-core/accessor/gslides'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { GSLIDES_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gslides/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/_client'
import { read as gslidesRead } from '@struktoai/mirage-core/core/gslides/read'
import { readdir as gslidesReaddir } from '@struktoai/mirage-core/core/gslides/readdir'
import { stat as gslidesStat } from '@struktoai/mirage-core/core/gslides/stat'
import { GSLIDES_OPS } from '@struktoai/mirage-core/ops/gslides/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import {
  GSLIDES_PROMPT,
  GSLIDES_WRITE_PROMPT,
} from '@struktoai/mirage-core/resource/gslides/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { redactGSlidesConfig, type GSlidesConfig, type GSlidesConfigRedacted } from './config.ts'

const gslidesResolveGlob = makeResolveGlob(gslidesReaddir)

export interface GSlidesResourceState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesResource implements Resource {
  readonly kind: string = ResourceName.GSLIDES
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GSLIDES_PROMPT
  readonly writePrompt: string = GSLIDES_WRITE_PROMPT
  readonly config: GSlidesConfig
  readonly accessor: GSlidesAccessor
  readonly index: IndexCacheStore

  constructor(config: GSlidesConfig) {
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
    this.index = new RAMIndexCacheStore({ ttl: 86_400 })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GSLIDES_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSLIDES_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gslidesRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gslidesReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gslidesStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
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
    return gslidesResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GSlidesResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSlidesConfig(this.config),
    })
  }

  loadState(_state: GSlidesResourceState): Promise<void> {
    return Promise.resolve()
  }
}
