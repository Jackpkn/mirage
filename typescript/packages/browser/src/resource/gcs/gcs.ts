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
import { gcsToS3Config, redactGcsConfig, type GCSConfig, type GCSConfigRedacted } from './config.ts'
import { GCS_BROWSER_PROMPT } from './prompt.ts'

export type GCSResourceState = S3AliasResourceState<GCSConfigRedacted>

export class GCSResource extends S3AliasResource<GCSConfig, GCSConfigRedacted> {
  override readonly prompt: string = GCS_BROWSER_PROMPT

  constructor(config: GCSConfig) {
    super(ResourceName.GCS, config, gcsToS3Config(config), redactGcsConfig)
  }
}
