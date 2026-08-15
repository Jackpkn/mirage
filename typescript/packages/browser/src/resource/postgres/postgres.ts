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

import { mountKey, mountPrefixOf } from '@struktoai/mirage-core'
import {
  type FileStat,
  type IndexCacheStore,
  PathSpec,
  type PgDriver,
  POSTGRES_COMMANDS,
  POSTGRES_OPS,
  POSTGRES_PROMPT,
  PostgresAccessor,
  type PostgresConfig,
  type PostgresConfigResolved,
  postgresRead,
  postgresReaddir,
  postgresStat,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  redactPostgresConfig,
  type PostgresConfigRedacted,
  resolvePostgresConfig,
  makeResolveGlob,
} from '@struktoai/mirage-core'
import { NeonPgDriver } from './neon_driver.ts'

const resolvePostgresGlob = makeResolveGlob(postgresReaddir)

export interface PostgresResourceOptions {
  config: PostgresConfig
  prefix?: string
  driver?: PgDriver
}

export interface PostgresResourceState {
  type: string
  config: PostgresConfigRedacted
  needs_override: true
}

export class PostgresResource implements Resource {
  readonly kind: string = ResourceName.POSTGRES
  readonly cachesReads: boolean = false
  readonly indexTtl: number = 0
  readonly prompt: string
  readonly config: PostgresConfigResolved
  readonly driver: PgDriver
  readonly accessor: PostgresAccessor
  readonly index: IndexCacheStore

  constructor(options: PostgresResourceOptions | PostgresConfig) {
    const { config, prefix, driver } =
      'config' in options ? options : { config: options, prefix: undefined, driver: undefined }
    this.config = resolvePostgresConfig(config)
    this.driver = driver ?? new NeonPgDriver(this.config.dsn)
    this.accessor = new PostgresAccessor(this.driver, this.config)
    this.index = new RAMIndexCacheStore({ ttl: this.indexTtl })
    this.prompt = POSTGRES_PROMPT.replace('{prefix}', prefix ?? '')
  }

  getState(): PostgresResourceState {
    return {
      type: this.kind,
      config: redactPostgresConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMResource for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python rebuilds via its registry, so it
      // writes this on only four resources and reads it nowhere.
      needs_override: true,
    }
  }

  // The rows live in the database, so a restored mount reaches them
  // through its config alone — there is nothing to take back.
  loadState(_state: PostgresResourceState): Promise<void> {
    return Promise.resolve()
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  ops(): readonly RegisteredOp[] {
    return POSTGRES_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return POSTGRES_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return postgresRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return postgresReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return postgresStat(this.accessor, p, this.index)
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
    return resolvePostgresGlob(this.accessor, effective, this.index)
  }
}
