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

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { remapCommandsResource, remapOpsResource } from '@struktoai/mirage-core/resource/s3/remap'
import { ResourceName } from '@struktoai/mirage-core/types'
import { S3Resource } from '../s3/s3.ts'
import {
  backblazeToS3Config,
  redactBackblazeConfig,
  type BackblazeConfig,
  type BackblazeConfigRedacted,
} from './config.ts'
import { BACKBLAZE_PROMPT } from './prompt.ts'

export interface BackblazeResourceState {
  type: string
  config: BackblazeConfigRedacted
}

export class BackblazeResource extends S3Resource {
  override readonly kind: string = ResourceName.BACKBLAZE
  override readonly prompt: string = BACKBLAZE_PROMPT
  readonly backblazeConfig: BackblazeConfig
  private readonly backblazeOps: readonly RegisteredOp[]
  private readonly backblazeCommands: readonly RegisteredCommand[]

  constructor(config: BackblazeConfig) {
    super(backblazeToS3Config(config))
    this.backblazeConfig = config
    this.backblazeOps = remapOpsResource(super.ops(), ResourceName.BACKBLAZE)
    this.backblazeCommands = remapCommandsResource(super.commands(), ResourceName.BACKBLAZE)
  }

  override ops(): readonly RegisteredOp[] {
    return this.backblazeOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.backblazeCommands
  }

  override getState(): Promise<BackblazeResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactBackblazeConfig(this.backblazeConfig),
    })
  }

  override loadState(_state: BackblazeResourceState): Promise<void> {
    return Promise.resolve()
  }
}
