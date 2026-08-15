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
import { gcsToS3Config, redactGcsConfig, type GCSConfig, type GCSConfigRedacted } from './config.ts'
import { GCS_BROWSER_PROMPT } from './prompt.ts'

export interface GCSResourceState {
  type: string
  config: GCSConfigRedacted
}

export class GCSResource extends S3Resource {
  override readonly kind: string = ResourceName.GCS
  override readonly prompt: string = GCS_BROWSER_PROMPT
  readonly gcsConfig: GCSConfig
  private readonly gcsOps: readonly RegisteredOp[]
  private readonly gcsCommands: readonly RegisteredCommand[]

  constructor(config: GCSConfig) {
    super(gcsToS3Config(config))
    this.gcsConfig = config
    this.gcsOps = remapOpsResource(super.ops(), ResourceName.GCS)
    this.gcsCommands = remapCommandsResource(super.commands(), ResourceName.GCS)
  }

  override ops(): readonly RegisteredOp[] {
    return this.gcsOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.gcsCommands
  }

  override getState(): Promise<GCSResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGcsConfig(this.gcsConfig),
    })
  }

  override loadState(_state: GCSResourceState): Promise<void> {
    return Promise.resolve()
  }
}
