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
  qingStorToS3Config,
  redactQingStorConfig,
  type QingStorConfig,
  type QingStorConfigRedacted,
} from './config.ts'
import { QINGSTOR_BROWSER_PROMPT } from './prompt.ts'

export interface QingStorResourceState {
  type: string
  config: QingStorConfigRedacted
}

export class QingStorResource extends S3Resource {
  override readonly kind: string = ResourceName.QINGSTOR
  override readonly prompt: string = QINGSTOR_BROWSER_PROMPT
  readonly qingStorConfig: QingStorConfig
  private readonly qingStorOps: readonly RegisteredOp[]
  private readonly qingStorCommands: readonly RegisteredCommand[]

  constructor(config: QingStorConfig) {
    super(qingStorToS3Config(config))
    this.qingStorConfig = config
    this.qingStorOps = remapOpsResource(super.ops(), ResourceName.QINGSTOR)
    this.qingStorCommands = remapCommandsResource(super.commands(), ResourceName.QINGSTOR)
  }

  override ops(): readonly RegisteredOp[] {
    return this.qingStorOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.qingStorCommands
  }

  override getState(): Promise<QingStorResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactQingStorConfig(this.qingStorConfig),
    })
  }

  override loadState(_state: QingStorResourceState): Promise<void> {
    return Promise.resolve()
  }
}
