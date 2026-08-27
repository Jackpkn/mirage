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

import { normalizeKeyPrefix } from '@struktoai/mirage-core/resource/s3/config'
import { ResourceName } from '@struktoai/mirage-core/types'
import { HfSpacesHubAccessor } from '../../accessor/hf_hub.ts'
import {
  assertHfRepoRef,
  type HfRepoConfig,
  type HfRepoConfigRedacted,
  redactHfRepoConfig,
} from '../hf_buckets/config.ts'
import { HfHubResource } from '../hf_hub/base.ts'
import { HF_SPACES_PROMPT } from './prompt.ts'

export interface HfSpacesResourceState {
  type: string
  config: HfRepoConfigRedacted
}

export class HfSpacesResource extends HfHubResource {
  readonly kind: string = ResourceName.HF_SPACES
  readonly prompt: string = HF_SPACES_PROMPT
  readonly config: HfRepoConfig
  readonly accessor: HfSpacesHubAccessor

  constructor(config: HfRepoConfig) {
    super()
    assertHfRepoRef(config.repoId, 'repo_id')
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: HfRepoConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new HfSpacesHubAccessor(this.config)
  }

  getState(): Promise<HfSpacesResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactHfRepoConfig(this.config),
    })
  }
}
