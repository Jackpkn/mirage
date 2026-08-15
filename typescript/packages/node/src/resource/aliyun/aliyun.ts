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
  aliyunToS3Config,
  redactAliyunConfig,
  type AliyunConfig,
  type AliyunConfigRedacted,
} from './config.ts'
import { ALIYUN_PROMPT } from './prompt.ts'

export interface AliyunResourceState {
  type: string
  config: AliyunConfigRedacted
}

export class AliyunResource extends S3Resource {
  override readonly kind: string = ResourceName.ALIYUN
  override readonly prompt: string = ALIYUN_PROMPT
  readonly aliyunConfig: AliyunConfig
  private readonly aliyunOps: readonly RegisteredOp[]
  private readonly aliyunCommands: readonly RegisteredCommand[]

  constructor(config: AliyunConfig) {
    super(aliyunToS3Config(config))
    this.aliyunConfig = config
    this.aliyunOps = remapOpsResource(super.ops(), ResourceName.ALIYUN)
    this.aliyunCommands = remapCommandsResource(super.commands(), ResourceName.ALIYUN)
  }

  override ops(): readonly RegisteredOp[] {
    return this.aliyunOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.aliyunCommands
  }

  override getState(): Promise<AliyunResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactAliyunConfig(this.aliyunConfig),
    })
  }

  override loadState(_state: AliyunResourceState): Promise<void> {
    return Promise.resolve()
  }
}
