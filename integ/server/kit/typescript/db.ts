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

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KitError } from './errors.ts'
import { runId } from './tenant.ts'

export interface MinimalClient {
  $disconnect(): Promise<void>
}

export type ClientCtor<C extends MinimalClient> = new (opts: { datasourceUrl: string }) => C

export interface PoolOptions<C extends MinimalClient> {
  service: string
  schema: string
  ctor: ClientCtor<C>
}

const SCHEMA_ENV = 'INTEG_DB_URL'

function prismaBin(): string {
  return createRequire(import.meta.url).resolve('prisma/build/index.js')
}

// Measured on this repo: the CLI spawn is ~374ms of which only ~10ms is engine
// work, and a file copy is ~1ms. So the schema is pushed ONCE into a template
// file per pool and every run file is a copy of it. A per-run push
// would put a third of a second on the clock for each /reset.
function pushTemplate(schema: string, target: string): void {
  try {
    execFileSync('node', [prismaBin(), 'db', 'push', '--schema', schema, '--skip-generate'], {
      env: { ...process.env, [SCHEMA_ENV]: `file:${target}` },
      stdio: 'pipe',
    })
  } catch (err: unknown) {
    throw new KitError(`db push failed for ${schema}: ${String(err)}`)
  }
}

// One SQLite FILE per run, keyed by run name. This is the isolation
// level that lets two runs share a process; the tenant column is the other one
// and lives inside a file. The client is constructed with `datasourceUrl`, not
// by mutating process.env: env is process-wide, so the env route cannot serve
// a second run at all (whichever client was constructed last wins).
export class ClientPool<C extends MinimalClient> {
  readonly service: string
  readonly schema: string
  readonly root: string
  private readonly ctor: ClientCtor<C>
  private readonly clients = new Map<string, C>()
  private template: string | null = null

  constructor(opts: PoolOptions<C>) {
    this.service = opts.service
    this.schema = opts.schema
    this.ctor = opts.ctor
    this.root = mkdtempSync(join(tmpdir(), `mirage-kit-${opts.service}-${runId()}-`))
  }

  fileFor(run: string): string {
    return join(this.root, `${run}.db`)
  }

  private ensureTemplate(): string {
    if (this.template === null) {
      const path = join(this.root, '_template.db')
      pushTemplate(this.schema, path)
      this.template = path
    }
    return this.template
  }

  client(run: string): C {
    const live = this.clients.get(run)
    if (live !== undefined) return live
    const file = this.fileFor(run)
    copyFileSync(this.ensureTemplate(), file)
    const made = new this.ctor({ datasourceUrl: `file:${file}` })
    this.clients.set(run, made)
    return made
  }

  // /reset recreates the run rather than deleting rows: a copy of the
  // template is one syscall and cannot leave a table the fake forgot to clear.
  async recreate(run: string): Promise<C> {
    await this.close(run)
    const file = this.fileFor(run)
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(`${file}${suffix}`, { force: true })
    }
    return this.client(run)
  }

  async close(run: string): Promise<void> {
    const live = this.clients.get(run)
    if (live === undefined) return
    this.clients.delete(run)
    await live.$disconnect()
  }

  runs(): string[] {
    return [...this.clients.keys()].sort()
  }

  async dispose(): Promise<void> {
    for (const run of [...this.clients.keys()]) {
      await this.close(run)
    }
    rmSync(this.root, { recursive: true, force: true })
    this.template = null
  }
}
