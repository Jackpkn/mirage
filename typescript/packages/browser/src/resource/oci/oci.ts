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
import { ociToS3Config, redactOciConfig, type OCIConfig, type OCIConfigRedacted } from './config.ts'
import { OCI_BROWSER_PROMPT } from './prompt.ts'

export interface OCIResourceState {
  type: string
  config: OCIConfigRedacted
}

export class OCIResource extends S3Resource {
  override readonly kind: string = ResourceName.OCI
  override readonly prompt: string = OCI_BROWSER_PROMPT
  readonly ociConfig: OCIConfig
  private readonly ociOps: readonly RegisteredOp[]
  private readonly ociCommands: readonly RegisteredCommand[]

  constructor(config: OCIConfig) {
    super(ociToS3Config(config))
    this.ociConfig = config
    this.ociOps = remapOpsResource(super.ops(), ResourceName.OCI)
    this.ociCommands = remapCommandsResource(super.commands(), ResourceName.OCI)
  }

  override ops(): readonly RegisteredOp[] {
    return this.ociOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.ociCommands
  }

  override getState(): Promise<OCIResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactOciConfig(this.ociConfig),
    })
  }

  override loadState(_state: OCIResourceState): Promise<void> {
    return Promise.resolve()
  }
}
