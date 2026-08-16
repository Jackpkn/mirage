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

import { SlackAccessor } from '@struktoai/mirage-core/accessor/slack'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { SLACK_COMMANDS } from '@struktoai/mirage-core/commands/builtin/slack/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { BrowserSlackTransport } from '@struktoai/mirage-core/core/slack/_client_browser'
import { read as slackRead } from '@struktoai/mirage-core/core/slack/read'
import { readdir as slackReaddir } from '@struktoai/mirage-core/core/slack/readdir'
import { stat as slackStat } from '@struktoai/mirage-core/core/slack/stat'
import { buildEventHook } from '@struktoai/mirage-core/core/slack/watch/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { SLACK_OPS } from '@struktoai/mirage-core/ops/slack/index'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { SLACK_PROMPT, SLACK_WRITE_PROMPT } from '@struktoai/mirage-core/resource/slack/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { EventHook } from '@struktoai/mirage-core/watch/index'
import { redactSlackConfig, type SlackConfig, type SlackConfigRedacted } from './config.ts'

const resolveSlackGlob = makeResolveGlob(slackReaddir)

export interface SlackResourceState {
  type: string
  config: SlackConfigRedacted
}

export class SlackResource implements Resource {
  readonly kind: string = ResourceName.SLACK
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: chat.jsonl and users/*.json
  // are rendered at readdir from payloads the listing already fetched
  // (users.list is payload-identical to users.info, verified live), and
  // file blobs carry Slack's upload byte count.
  readonly sizesAlwaysKnown: boolean = true
  readonly indexTtl: number = 600
  readonly prompt: string = SLACK_PROMPT
  readonly writePrompt: string = SLACK_WRITE_PROMPT
  readonly config: SlackConfig
  readonly accessor: SlackAccessor
  readonly index: IndexCacheStore

  constructor(config: SlackConfig) {
    this.config = config
    this.accessor = new SlackAccessor(
      new BrowserSlackTransport({
        proxyUrl: config.proxyUrl,
        ...(config.getHeaders !== undefined ? { getHeaders: config.getHeaders } : {}),
      }),
    )
    this.index = new RAMIndexCacheStore({ ttl: this.indexTtl })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return SLACK_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return SLACK_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return slackRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return slackReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return slackStat(this.accessor, p, this.index)
  }

  eventHook(): EventHook {
    return buildEventHook(this.accessor)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  resourcePath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveSlackGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<SlackResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactSlackConfig(this.config),
    })
  }

  loadState(_state: SlackResourceState): Promise<void> {
    return Promise.resolve()
  }
}
