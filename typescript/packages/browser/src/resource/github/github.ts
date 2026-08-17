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

import { GitHubAccessor } from '@struktoai/mirage-core/accessor/github'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { GITHUB_COMMANDS } from '@struktoai/mirage-core/commands/builtin/github/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import {
  HttpGitHubTransport,
  fetchRepoInfo as fetchGitHubRepoInfo,
  fetchTree as fetchGitHubTree,
} from '@struktoai/mirage-core/core/github/client'
import { read as githubRead } from '@struktoai/mirage-core/core/github/read'
import { readdir as githubReaddir } from '@struktoai/mirage-core/core/github/readdir'
import { stat as githubStat } from '@struktoai/mirage-core/core/github/stat'
import { buildTreeMap as githubBuildTreeMap } from '@struktoai/mirage-core/core/github/tree'
import { GITHUB_OPS } from '@struktoai/mirage-core/ops/github/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { GITHUB_PROMPT } from '@struktoai/mirage-core/resource/github/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { redactGitHubConfig, type GitHubConfig, type GitHubConfigRedacted } from './config.ts'

const githubResolveGlob = makeResolveGlob(githubReaddir)

export interface GitHubResourceState {
  type: string
  config: GitHubConfigRedacted
  defaultBranch: string
  truncated: boolean
}

export class GitHubResource implements Resource {
  readonly kind: string = ResourceName.GITHUB
  readonly cachesReads: boolean = true
  // The git tree API reports the exact blob size for every file; the
  // blob read returns those same bytes, and submodule gitlinks (which
  // have no size and no blob) are excluded from the tree.
  readonly sizesAlwaysKnown: boolean = true
  // Blob shas are stable per-path markers, so cached reads can be
  // probe-verified under ALWAYS and snapshots carry drift fingerprints.
  readonly supportsSnapshot: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GITHUB_PROMPT
  readonly config: GitHubConfig
  readonly accessor: GitHubAccessor
  readonly index: IndexCacheStore

  private constructor(config: GitHubConfig, accessor: GitHubAccessor, index: IndexCacheStore) {
    this.config = config
    this.accessor = accessor
    this.index = index
  }

  static async create(config: GitHubConfig): Promise<GitHubResource> {
    const transportOpts: { token: string; baseUrl?: string } = { token: config.token }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const transport = new HttpGitHubTransport(transportOpts)
    const repoInfo = await fetchGitHubRepoInfo(transport, config.owner, config.repo)
    const ref = config.ref ?? repoInfo.default_branch
    const { tree, truncated } = await fetchGitHubTree(transport, config.owner, config.repo, ref)
    const treeMap = githubBuildTreeMap(tree)
    const accessor = new GitHubAccessor({
      transport,
      owner: config.owner,
      repo: config.repo,
      ref,
      defaultBranch: repoInfo.default_branch,
      truncated,
      tree: treeMap,
    })
    // Not seeded here: the index is keyed by mount prefix, which only a
    // PathSpec knows, so the first read seeds it from the accessor's tree.
    const index = new RAMIndexCacheStore({ ttl: 86_400 })
    return new GitHubResource(config, accessor, index)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GITHUB_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GITHUB_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return githubRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return githubReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return githubStat(this.accessor, p, this.index)
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
    return githubResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GitHubResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGitHubConfig(this.config),
      defaultBranch: this.accessor.defaultBranch,
      truncated: this.accessor.truncated,
    })
  }

  loadState(_state: GitHubResourceState): Promise<void> {
    return Promise.resolve()
  }
}
