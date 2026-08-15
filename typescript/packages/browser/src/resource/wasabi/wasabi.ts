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
  redactWasabiConfig,
  wasabiToS3Config,
  type WasabiConfig,
  type WasabiConfigRedacted,
} from './config.ts'
import { WASABI_BROWSER_PROMPT } from './prompt.ts'

export interface WasabiResourceState {
  type: string
  config: WasabiConfigRedacted
}

export class WasabiResource extends S3Resource {
  override readonly kind: string = ResourceName.WASABI
  override readonly prompt: string = WASABI_BROWSER_PROMPT
  readonly wasabiConfig: WasabiConfig
  private readonly wasabiOps: readonly RegisteredOp[]
  private readonly wasabiCommands: readonly RegisteredCommand[]

  constructor(config: WasabiConfig) {
    super(wasabiToS3Config(config))
    this.wasabiConfig = config
    this.wasabiOps = remapOpsResource(super.ops(), ResourceName.WASABI)
    this.wasabiCommands = remapCommandsResource(super.commands(), ResourceName.WASABI)
  }

  override ops(): readonly RegisteredOp[] {
    return this.wasabiOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.wasabiCommands
  }

  override getState(): Promise<WasabiResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactWasabiConfig(this.wasabiConfig),
    })
  }

  override loadState(_state: WasabiResourceState): Promise<void> {
    return Promise.resolve()
  }
}
