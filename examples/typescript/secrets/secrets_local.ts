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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'
import { RAMSessionStore } from '@struktoai/mirage-core/workspace/session/ram'

// Two dotenv files stand in for two accounts. Nothing here is real, so
// the script prints the values it fetches -- an example against a live
// store would print a length or a prefix instead.
const VAULT = 'API_TOKEN=demo-token-abc123\nDB_PASSWORD=demo-pw-xyz789\n'
const FETCHED = ['demo-token-abc123', 'demo-pw-xyz789']

const dec = new TextDecoder()

/** Run one line and print what the agent would see. */
async function show(ws: Workspace, line: string): Promise<void> {
  const result = await ws.execute(line)
  console.log(`$ ${line}`)
  console.log(`  exit ${result.exitCode}`)
  const out = result.stdout === null ? '' : dec.decode(result.stdout).trim()
  const err = result.stderr === null ? '' : dec.decode(result.stderr).trim()
  if (out !== '') console.log(`  out: ${out}`)
  if (err !== '') console.log(`  err: ${err}`)
  console.log()
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'mirage-secrets-'))
  try {
    const vault = join(tmp, 'vault.env')
    writeFileSync(vault, VAULT)
    const store = new RAMSessionStore()
    const ws = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.WRITE,
        sessionStore: store,
        // One instance per account. `dotenv` needs only a path, so
        // both configs are literals; a source that needs a credential
        // would read it here through {from: env, ...}.
        secrets: {
          vault: { source: 'dotenv', config: { path: vault } },
          gone: { source: 'dotenv', config: { path: join(tmp, 'absent.env') } },
        },
        env: {
          API_TOKEN: { from: 'vault', key: 'API_TOKEN' },
          DB_PASSWORD: { from: 'vault', key: 'DB_PASSWORD' },
          MISSING: { from: 'gone', key: 'MISSING' },
          MIRAGE_ENV: { value: 'demo' },
        },
      },
    )

    console.log('=== a literal costs no fetch ===')
    await show(ws, 'echo "env is $MIRAGE_ENV"')

    console.log('=== a line naming no secret fetches nothing ===')
    await show(ws, 'echo hello > /data/note.txt; cat /data/note.txt')

    console.log('=== the value arrives for the line that reads it ===')
    await show(ws, 'echo "token: $API_TOKEN"')

    console.log('=== one source per instance: a dead one fails its own lines only ===')
    await show(ws, 'echo "missing: $MISSING"')
    await show(ws, 'echo "and this line still runs: $DB_PASSWORD"')

    // The one property worth seeing: `env` holds the literal, and
    // `managed` holds the pointer. Both fetched values were on the
    // session a moment ago and neither reached the store, so a
    // restored session starts declared-but-unfetched again.
    console.log('=== what the session persisted ===')
    // The store answers with a Map keyed by session id, and this
    // workspace has run one session.
    const record = [...(await store.load()).values()][0] ?? {}
    console.log('env:')
    for (const [name, value] of Object.entries(record.env ?? {}).sort()) {
      console.log(`  ${name}=${value}`)
    }
    console.log('managed (the pointer, never the value):')
    for (const [name, ref] of Object.entries(record.managed ?? {}).sort()) {
      console.log(`  ${name} from ${ref.from}, key ${ref.key}`)
    }
    const stored = JSON.stringify(record)
    const leaked = FETCHED.some((value) => stored.includes(value))
    console.log(`\na fetched value reached the store: ${leaked ? 'yes' : 'no'}`)

    await ws.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

await main()
