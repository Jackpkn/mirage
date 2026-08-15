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
  redactScalewayConfig,
  scalewayToS3Config,
  type ScalewayConfig,
  type ScalewayConfigRedacted,
} from './config.ts'
import { SCALEWAY_PROMPT } from './prompt.ts'

export interface ScalewayResourceState {
  type: string
  config: ScalewayConfigRedacted
}

export class ScalewayResource extends S3Resource {
  override readonly kind: string = ResourceName.SCALEWAY
  override readonly prompt: string = SCALEWAY_PROMPT
  readonly scalewayConfig: ScalewayConfig
  private readonly scalewayOps: readonly RegisteredOp[]
  private readonly scalewayCommands: readonly RegisteredCommand[]

  constructor(config: ScalewayConfig) {
    super(scalewayToS3Config(config))
    this.scalewayConfig = config
    this.scalewayOps = remapOpsResource(super.ops(), ResourceName.SCALEWAY)
    this.scalewayCommands = remapCommandsResource(super.commands(), ResourceName.SCALEWAY)
  }

  override ops(): readonly RegisteredOp[] {
    return this.scalewayOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.scalewayCommands
  }

  override getState(): Promise<ScalewayResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactScalewayConfig(this.scalewayConfig),
    })
  }

  override loadState(_state: ScalewayResourceState): Promise<void> {
    return Promise.resolve()
  }
}
