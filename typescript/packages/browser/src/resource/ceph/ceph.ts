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
  cephToS3Config,
  redactCephConfig,
  type CephConfig,
  type CephConfigRedacted,
} from './config.ts'
import { CEPH_BROWSER_PROMPT } from './prompt.ts'

export interface CephResourceState {
  type: string
  config: CephConfigRedacted
}

export class CephResource extends S3Resource {
  override readonly kind: string = ResourceName.CEPH
  override readonly prompt: string = CEPH_BROWSER_PROMPT
  readonly cephConfig: CephConfig
  private readonly cephOps: readonly RegisteredOp[]
  private readonly cephCommands: readonly RegisteredCommand[]

  constructor(config: CephConfig) {
    super(cephToS3Config(config))
    this.cephConfig = config
    this.cephOps = remapOpsResource(super.ops(), ResourceName.CEPH)
    this.cephCommands = remapCommandsResource(super.commands(), ResourceName.CEPH)
  }

  override ops(): readonly RegisteredOp[] {
    return this.cephOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.cephCommands
  }

  override getState(): Promise<CephResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactCephConfig(this.cephConfig),
    })
  }

  override loadState(_state: CephResourceState): Promise<void> {
    return Promise.resolve()
  }
}
