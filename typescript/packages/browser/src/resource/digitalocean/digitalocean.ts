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
  digitalOceanToS3Config,
  redactDigitalOceanConfig,
  type DigitalOceanConfig,
  type DigitalOceanConfigRedacted,
} from './config.ts'
import { DIGITALOCEAN_BROWSER_PROMPT } from './prompt.ts'

export interface DigitalOceanResourceState {
  type: string
  config: DigitalOceanConfigRedacted
}

export class DigitalOceanResource extends S3Resource {
  override readonly kind: string = ResourceName.DIGITALOCEAN
  override readonly prompt: string = DIGITALOCEAN_BROWSER_PROMPT
  readonly digitalOceanConfig: DigitalOceanConfig
  private readonly digitalOceanOps: readonly RegisteredOp[]
  private readonly digitalOceanCommands: readonly RegisteredCommand[]

  constructor(config: DigitalOceanConfig) {
    super(digitalOceanToS3Config(config))
    this.digitalOceanConfig = config
    this.digitalOceanOps = remapOpsResource(super.ops(), ResourceName.DIGITALOCEAN)
    this.digitalOceanCommands = remapCommandsResource(super.commands(), ResourceName.DIGITALOCEAN)
  }

  override ops(): readonly RegisteredOp[] {
    return this.digitalOceanOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.digitalOceanCommands
  }

  override getState(): Promise<DigitalOceanResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDigitalOceanConfig(this.digitalOceanConfig),
    })
  }

  override loadState(_state: DigitalOceanResourceState): Promise<void> {
    return Promise.resolve()
  }
}
