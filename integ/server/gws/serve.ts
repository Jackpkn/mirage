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

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import {
  DEFAULT_TENANT,
  HEALTH_PATH,
  KitError,
  RESET_PATH,
  ResetBodyError,
  Router,
  TenantError,
  announceFor,
  bindHost,
  emit,
  parseBody,
  parsePort,
  resolveRun,
  splitRunPath,
  withPathRun,
  unroutedLine,
} from '../kit/typescript/index.ts'
import type {
  Ctx,
  Headers,
  JsonValue,
  KitConfig,
  KitRoute,
  Reply,
} from '../kit/typescript/index.ts'
import { buildState, parseGwsReset } from './reset.ts'
import type { GwsState } from './store/state.ts'
import { unknownRoute } from './wire/reply.ts'

// gws's server is the kit's, minus the ClientPool: the run is resolved, the
// router is the kit's Router (so writes serialize per run the same way), the
// health and reset paths are the kit's paths, and the announce line is the
// kit's. What differs is only where a run's state lives -- an in-memory
// GwsState instead of a SQLite file -- which is the one thing this pass
// deliberately does not change. When gws moves onto Prisma this whole file is
// replaced by `serve(fake)` from the kit.
export interface GwsFake {
  config: KitConfig
  routes: () => KitRoute<GwsState>[]
}

export interface GwsStarted {
  endpoint: string
  port: number
  server: Server
  close: () => Promise<void>
}

export class GwsRuntime {
  readonly fake: GwsFake
  private readonly states = new Map<string, GwsState>()

  constructor(fake: GwsFake) {
    this.fake = fake
  }

  state(run: string): GwsState {
    const live = this.states.get(run)
    if (live !== undefined) return live
    const made = buildState({ run, calendars: null, forms: null }, this.fake.config.mintSharing)
    this.states.set(run, made)
    return made
  }

  reset(body: JsonValue): JsonValue {
    const req = parseGwsReset(body)
    this.states.set(req.run, buildState(req, this.fake.config.mintSharing))
    return { ok: true }
  }

  runs(): string[] {
    return [...this.states.keys()].sort()
  }
}

function send(res: ServerResponse, reply: Reply, head: boolean): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) }
  let payload: Buffer
  if (reply.body === undefined) {
    payload = Buffer.alloc(0)
  } else if (Buffer.isBuffer(reply.body)) {
    payload = reply.body
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/octet-stream'
  } else {
    payload = Buffer.from(JSON.stringify(reply.body), 'utf8')
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
  }
  // A 204 carries no body and no Content-Length; Drive answers deletes that
  // way and a length header on one is a protocol error.
  if (reply.status !== 204) headers['Content-Length'] = String(payload.length)
  res.writeHead(reply.status, headers)
  res.end(head || reply.status === 204 ? undefined : payload)
}

function envelope(service: string, err: unknown): Reply {
  const message = err instanceof Error ? err.message : String(err)
  const kind = err instanceof KitError ? err.constructor.name : 'Error'
  process.stderr.write(`${service} fake: ${kind}: ${message}\n`)
  return {
    status: 500,
    body: { error: { code: 500, message: 'internal error', status: 'INTERNAL' } },
  }
}

async function answer(
  rt: GwsRuntime,
  router: Router<GwsState>,
  method: string,
  url: URL,
  headers: Headers,
  raw: Buffer,
): Promise<Reply> {
  const { service } = rt.fake.config
  // The same `/_run/<id>` prefix the kit strips, and gws has to strip it in
  // its own copy of this flow or the run axis works everywhere except here.
  // gws already keeps a separate in-memory world per run; what it lacked was
  // a way for a mount to ASK for one, since a mount hands its base URL to a
  // client and never sees the request again.
  let pathRun: string | undefined
  let path: string
  try {
    const split = splitRunPath(url.pathname)
    pathRun = split.run
    path = split.path
    // The URL a HANDLER reads loses the prefix too, exactly as in the kit.
    // gws handlers pass ctx.url.pathname to unknownRoute (docs/routes.ts and
    // several branches of sheets/routes.ts), so a scoped request answered
    // `Unknown route: POST /_run/<random-id>/v1/...`: the harness's run id in
    // observable output, which no golden can match twice.
    url.pathname = path
  } catch (err: unknown) {
    if (err instanceof TenantError) {
      return {
        status: 400,
        body: { error: 'bad_run', kind: err.constructor.name, message: err.message },
      }
    }
    throw err
  }
  if (path === HEALTH_PATH && (method === 'GET' || method === 'HEAD')) {
    return { status: 200, body: { ok: true, service, runs: rt.runs() } }
  }
  if (path === RESET_PATH && method === 'POST') {
    try {
      return { status: 200, body: rt.reset(withPathRun(parseBody(raw), pathRun)) }
    } catch (err: unknown) {
      if (err instanceof ResetBodyError || err instanceof TenantError) {
        return {
          status: 400,
          body: { error: 'bad_reset', kind: err.constructor.name, message: err.message },
        }
      }
      throw err
    }
  }
  let run: string
  try {
    run = resolveRun(headers, url, pathRun)
  } catch (err: unknown) {
    // A run name the kit refuses is the caller's mistake, and it is the same
    // mistake /reset already answers 400 for. Letting it reach the google 500
    // envelope reported a fake bug for a bad header.
    if (err instanceof TenantError) {
      return {
        status: 400,
        body: { error: 'bad_run', kind: err.constructor.name, message: err.message },
      }
    }
    throw err
  }
  const hit = router.match(method, path)
  if (hit === null) {
    process.stderr.write(`${unroutedLine(service, method, path)}\n`)
    return unknownRoute(method, path)
  }
  const st = rt.state(run)
  const ctx: Ctx<GwsState> = {
    params: hit.params,
    query: url.searchParams,
    body: raw,
    run,
    tenant: DEFAULT_TENANT,
    db: st,
    clock: st.clock,
    minter: st.minter,
    headers,
    url,
    json: () => parseBody(raw),
  }
  return router.run(hit.spec, ctx)
}

export function createGwsServer(rt: GwsRuntime): Server {
  const { service, maxBodyBytes } = rt.fake.config
  const router = new Router<GwsState>(rt.fake.routes())
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? '127.0.0.1'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        // Stop buffering, but keep draining and answer on `end`. Writing the
        // 413 here and destroying the socket in the same tick, which is what
        // the kit's http.ts does, resets the connection while the peer is
        // still writing: the client never reads the status it was sent, it
        // reads ECONNRESET, so the refusal is indistinguishable from a
        // crashed fake.
        refused = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) {
        send(
          res,
          { status: 413, body: { error: 'body_too_large', limit: maxBodyBytes } },
          method === 'HEAD',
        )
        return
      }
      void answer(rt, router, method, url, req.headers as Headers, Buffer.concat(chunks))
        .then((reply) => {
          send(res, reply, method === 'HEAD')
        })
        .catch((err: unknown) => {
          send(res, envelope(service, err), method === 'HEAD')
        })
    })
  })
}

export async function startGws(fake: GwsFake, port = 0): Promise<GwsStarted> {
  const rt = new GwsRuntime(fake)
  const server = createGwsServer(rt)
  await new Promise<void>((resolve) => {
    server.listen(port, bindHost(), () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new KitError(`${fake.config.service} fake: no port`)
  }
  const { url } = announceFor(fake.config.service, address.port)
  return {
    endpoint: url,
    port: address.port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

export async function serveGws(fake: GwsFake): Promise<GwsStarted> {
  const started = await startGws(fake, parsePort(process.argv.slice(2), fake.config.defaultPort))
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
