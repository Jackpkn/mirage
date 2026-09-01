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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

import { SourceBlockSchema } from '@struktoai/mirage-core/secrets/config'
import { resolveSources } from '@struktoai/mirage-core/secrets/sources'
import { MountMode, Workspace, buildResource } from '@struktoai/mirage-node'

const HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(HERE, '../../../.env.development') })

const OP = SourceBlockSchema.parse({
  source: '1password',
  config: { token: { from: 'env', key: 'OP_SERVICE_ACCOUNT_TOKEN' } },
})

const BOT = { from: 'op', ref: 'op://mirage/SLACK_BOT_TOKEN', key: 'credential' }
const USER = { from: 'op', ref: 'op://mirage/SLACK_USER_TOKEN', key: 'credential' }

const LINES = [
  'ls /remote | head -n 3',
  'ls /local | head -n 3',
  'echo "bot token: ${#SLACK_BOT_TOKEN} chars"',
  'echo "user token: ${#SLACK_USER_TOKEN} chars"',
  // A session write beats the pointer; the mount keeps its own token.
  'export SLACK_BOT_TOKEN=overridden-in-session',
  'echo "bot token now: $SLACK_BOT_TOKEN"',
  'ls /remote | head -n 1',
]

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
  const sources = await resolveSources({ op: OP })

  // A mount whose credentials come from 1Password. `buildResource` is
  // async, so the pointers are fetched there; python resolves them in
  // `resolve_secrets` before its sync `build_resource`. Same shape.
  const remote = await buildResource('slack', { token: BOT, searchToken: USER }, sources)

  // And one from the dotenv this process already loaded. Nothing about
  // the config differs; only where the string came from.
  const token = process.env.SLACK_BOT_TOKEN
  if (token === undefined || token === '') throw new Error('SLACK_BOT_TOKEN is required')
  const local = await buildResource('slack', { token })

  const ws = new Workspace(
    { '/remote': remote, '/local': local },
    {
      mode: MountMode.READ,
      secrets: { op: OP },
      env: { SLACK_BOT_TOKEN: BOT, SLACK_USER_TOKEN: USER },
    },
  )
  for (const line of LINES) await show(ws, line)
  await ws.close()
}

await main()
