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

import type { Server } from 'node:http'
import { announceFor, emit } from './announce.ts'
import type { Fake, Runtime } from './base.ts'
import { bindHost } from './bind.ts'
import type { MinimalClient } from './db.ts'
import { createKitServer, makeRuntime } from './http.ts'
import { parseFixture, parsePort } from './port.ts'

export interface Started<C extends MinimalClient> {
  endpoint: string
  port: number
  server: Server
  runtime: Runtime<C>
  close: () => Promise<void>
}

// In-process: a host that already has an event loop starts the fake on an
// ephemeral port and gets a real teardown back. `close` disposes the pool as
// well as the socket, so a run leaves no SQLite files behind.
export async function start<C extends MinimalClient>(
  fake: Fake<C>,
  port = 0,
  fixture?: string,
): Promise<Started<C>> {
  const runtime = makeRuntime(fake)
  // Seed the default run BEFORE listening. Every fake this kit replaces called
  // seed() inside its own startServer, so it answered the fixture the instant
  // the socket opened; a kit fake that served nothing until the first /reset
  // would be empty for any caller that does not reset first, which is a
  // behaviour change no test asks for. Seeding before listen also means there
  // is no window where the port is open and the data is not there.
  await runtime.reset(fixture === undefined ? {} : { fixture })
  const server = createKitServer(runtime)
  await new Promise<void>((resolve) => {
    server.listen(port, bindHost(), () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`${fake.config.service} fake: no port`)
  }
  const { url } = announceFor(fake.config.service, address.port)
  return {
    endpoint: url,
    port: address.port,
    server,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await runtime.dispose()
    },
  }
}

// Standalone: parse --port, listen, announce on stdout, and tear down on the
// signals a supervisor sends. The announce line is the only thing a runner
// parses, so it is written after listen resolves and never before.
export async function serve<C extends MinimalClient>(fake: Fake<C>): Promise<Started<C>> {
  const argv = process.argv.slice(2)
  const started = await start(fake, parsePort(argv, fake.config.defaultPort), parseFixture(argv))
  emit(announceFor(fake.config.service, started.port))
  const bye = (): void => {
    void started.close().then(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  return started
}
