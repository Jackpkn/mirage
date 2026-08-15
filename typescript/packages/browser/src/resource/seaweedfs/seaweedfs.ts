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
  redactSeaweedFSConfig,
  seaweedfsToS3Config,
  type SeaweedFSConfig,
  type SeaweedFSConfigRedacted,
} from './config.ts'
import { SEAWEEDFS_BROWSER_PROMPT } from './prompt.ts'

export interface SeaweedFSResourceState {
  type: string
  config: SeaweedFSConfigRedacted
}

export class SeaweedFSResource extends S3Resource {
  override readonly kind: string = ResourceName.SEAWEEDFS
  override readonly prompt: string = SEAWEEDFS_BROWSER_PROMPT
  readonly seaweedfsConfig: SeaweedFSConfig
  private readonly seaweedfsOps: readonly RegisteredOp[]
  private readonly seaweedfsCommands: readonly RegisteredCommand[]

  constructor(config: SeaweedFSConfig) {
    super(seaweedfsToS3Config(config))
    this.seaweedfsConfig = config
    this.seaweedfsOps = remapOpsResource(super.ops(), ResourceName.SEAWEEDFS)
    this.seaweedfsCommands = remapCommandsResource(super.commands(), ResourceName.SEAWEEDFS)
  }

  override ops(): readonly RegisteredOp[] {
    return this.seaweedfsOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.seaweedfsCommands
  }

  override getState(): Promise<SeaweedFSResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactSeaweedFSConfig(this.seaweedfsConfig),
    })
  }

  override loadState(_state: SeaweedFSResourceState): Promise<void> {
    return Promise.resolve()
  }
}
