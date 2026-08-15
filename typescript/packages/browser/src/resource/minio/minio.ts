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
  minioToS3Config,
  redactMinIOConfig,
  type MinIOConfig,
  type MinIOConfigRedacted,
} from './config.ts'
import { MINIO_BROWSER_PROMPT } from './prompt.ts'

export interface MinIOResourceState {
  type: string
  config: MinIOConfigRedacted
}

export class MinIOResource extends S3Resource {
  override readonly kind: string = ResourceName.MINIO
  override readonly prompt: string = MINIO_BROWSER_PROMPT
  readonly minioConfig: MinIOConfig
  private readonly minioOps: readonly RegisteredOp[]
  private readonly minioCommands: readonly RegisteredCommand[]

  constructor(config: MinIOConfig) {
    super(minioToS3Config(config))
    this.minioConfig = config
    this.minioOps = remapOpsResource(super.ops(), ResourceName.MINIO)
    this.minioCommands = remapCommandsResource(super.commands(), ResourceName.MINIO)
  }

  override ops(): readonly RegisteredOp[] {
    return this.minioOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.minioCommands
  }

  override getState(): Promise<MinIOResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactMinIOConfig(this.minioConfig),
    })
  }

  override loadState(_state: MinIOResourceState): Promise<void> {
    return Promise.resolve()
  }
}
