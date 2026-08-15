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
  redactTencentConfig,
  tencentToS3Config,
  type TencentConfig,
  type TencentConfigRedacted,
} from './config.ts'
import { TENCENT_PROMPT } from './prompt.ts'

export interface TencentResourceState {
  type: string
  config: TencentConfigRedacted
}

export class TencentResource extends S3Resource {
  override readonly kind: string = ResourceName.TENCENT
  override readonly prompt: string = TENCENT_PROMPT
  readonly tencentConfig: TencentConfig
  private readonly tencentOps: readonly RegisteredOp[]
  private readonly tencentCommands: readonly RegisteredCommand[]

  constructor(config: TencentConfig) {
    super(tencentToS3Config(config))
    this.tencentConfig = config
    this.tencentOps = remapOpsResource(super.ops(), ResourceName.TENCENT)
    this.tencentCommands = remapCommandsResource(super.commands(), ResourceName.TENCENT)
  }

  override ops(): readonly RegisteredOp[] {
    return this.tencentOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.tencentCommands
  }

  override getState(): Promise<TencentResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactTencentConfig(this.tencentConfig),
    })
  }

  override loadState(_state: TencentResourceState): Promise<void> {
    return Promise.resolve()
  }
}
