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

import { ResourceName } from '@struktoai/mirage-core/types'
import { S3AliasResource, type S3AliasResourceState } from '../s3_alias.ts'
import {
  redactScalewayConfig,
  scalewayToS3Config,
  type ScalewayConfig,
  type ScalewayConfigRedacted,
} from './config.ts'
import { SCALEWAY_PROMPT } from './prompt.ts'

export type ScalewayResourceState = S3AliasResourceState<ScalewayConfigRedacted>

export class ScalewayResource extends S3AliasResource<ScalewayConfig, ScalewayConfigRedacted> {
  override readonly prompt: string = SCALEWAY_PROMPT

  constructor(config: ScalewayConfig) {
    super(ResourceName.SCALEWAY, config, scalewayToS3Config(config), redactScalewayConfig)
  }
}
