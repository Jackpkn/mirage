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
import { makePool, makeState } from './base.ts'
import type { Fake, Runtime, RunState } from './base.ts'
import type { MinimalClient } from './db.ts'
import { FixtureError, KitError, ResetBodyError, TenantError } from './errors.ts'
import { Router } from './route.ts'
import type { Ctx } from './route.ts'
import { DEFAULT_FIXTURE } from './fixture.ts'
import { applyReset, defaultTenantsOf, parseResetBody } from './reset.ts'
import { DEFAULT_RUN, resolveRun, resolveTenant } from './tenant.ts'
import type { Headers } from './tenant.ts'
import { unrouted } from './unrouted.ts'
import type { JsonValue, Reply } from './types.ts'

export const HEALTH_PATH = '/_kit/health'
export const RESET_PATH = '/reset'

export function makeRuntime<C extends MinimalClient>(fake: Fake<C>): Runtime<C> {
  const pool = makePool(fake)
  const states = new Map<string, RunState>()
  const state = (run: string): RunState => {
    const live = states.get(run)
    if (live !== undefined) return live
    const made = makeState(fake)
    states.set(run, made)
    return made
  }
  // The fixture a bare /reset replays. `--fixture` sets it at startup and a
  // reset that names one replaces it, so a harness seeds once when the
  // scenario changes and then resets freely within it. Defaulting every bare
  // reset back to `v1` would put a server started on another fixture back on
  // the wrong scenario the first time a host reset it.
  let current = DEFAULT_FIXTURE
  return {
    fake,
    pool,
    state,
    reset: (body: JsonValue) => {
      const req = parseResetBody(body, defaultTenantsOf(fake), current)
      current = req.fixture
      return applyReset(fake, pool, state, req)
    },
    dispose: async () => {
      states.clear()
      await pool.dispose()
    },
  }
}

// The reset's target run is read before validation so the queue key exists even
// for a body that parseResetBody will reject; an invalid body is a 400 that
// still must not jump the queue.
function runOfReset(body: JsonValue): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const named = (body as Record<string, JsonValue>).run
    if (typeof named === 'string' && named !== '') return named
  }
  return DEFAULT_RUN
}

export function parseBody(raw: Buffer): JsonValue {
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8')) as JsonValue
}

// /reset reads its body itself rather than through parseBody, because a
// malformed one is the caller's mistake and belongs in the same 400 envelope
// as an unknown field. JSON.parse raises a SyntaxError, which is not a
// KitError, so it fell past the catch below and answered the 500 envelope --
// a typo'd curl read as a crashed fake. A malformed body on an ordinary route
// still throws, which is what the fakes' originals did.
function parseResetRequest(raw: Buffer): JsonValue {
  try {
    return parseBody(raw)
  } catch (err: unknown) {
    throw new ResetBodyError(`/reset body is not JSON: ${(err as Error).message}`)
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
  // RFC 7230 forbids Content-Length on a 204 or a 304, and every aiohttp fake
  // this kit replaces omitted it there, so a caller diffing the two sees the
  // same headers. A HEAD still carries the length its GET would have.
  if (reply.status !== 204 && reply.status !== 304) {
    headers['Content-Length'] = String(payload.length)
  }
  res.writeHead(reply.status, headers)
  res.end(head ? undefined : payload)
}

// A fake that throws must say so in a shape the caller can read, and must not
// take the process down: a 500 carrying the message beats a hung socket, which
// is indistinguishable from a slow backend.
function envelope(service: string, err: unknown): Reply {
  const message = err instanceof Error ? err.message : String(err)
  const kind = err instanceof KitError ? err.constructor.name : 'Error'
  process.stderr.write(`${service} fake: ${kind}: ${message}\n`)
  return { status: 500, body: { error: 'internal_error', kind, message } }
}

async function answer<C extends MinimalClient>(
  rt: Runtime<C>,
  router: Router<C>,
  method: string,
  url: URL,
  headers: Headers,
  raw: Buffer,
): Promise<Reply> {
  const { service, tenantKind, tenantFromBearer, tenantTokenPattern } = rt.fake.config
  if (url.pathname === HEALTH_PATH && (method === 'GET' || method === 'HEAD')) {
    return { status: 200, body: { ok: true, service, runs: rt.pool.runs() } }
  }
  if (url.pathname === RESET_PATH && method === 'POST') {
    try {
      // Enqueued on the run's own write queue. A reset deletes and reseeds
      // rows, and for a fake with no tenant column recreates the SQLite file
      // outright, so running it beside an in-flight write unlinked the
      // database under that write: the request 500'd and every later request
      // on the run failed forever. It is a write and queues like one.
      const body = parseResetRequest(raw)
      const done = await router.enqueue(runOfReset(body), () => rt.reset(body))
      return { status: 200, body: JSON.parse(JSON.stringify(done)) as JsonValue }
    } catch (err: unknown) {
      // A body the kit will not interpret is the caller's mistake, so it is a
      // 400 naming the field. Only a failure inside the seed falls through to
      // the 500 envelope, where it belongs.
      if (
        err instanceof ResetBodyError ||
        err instanceof FixtureError ||
        err instanceof TenantError
      ) {
        return {
          status: 400,
          body: { error: 'bad_reset', kind: err.constructor.name, message: err.message },
        }
      }
      throw err
    }
  }
  let run: string
  let tenant: string
  try {
    run = resolveRun(headers, url)
    tenant = resolveTenant(headers, url, tenantKind, tenantFromBearer, tenantTokenPattern)
  } catch (err: unknown) {
    // Same shape /reset already used, just reached from the request path. An
    // illegal `?_run=..%2Fx` or `?_tenant=bad name` reached the 500 envelope
    // from here, so a caller typo read as a crashed fake.
    if (err instanceof TenantError) {
      return {
        status: 400,
        body: { error: 'bad_tenant', kind: err.constructor.name, message: err.message },
      }
    }
    throw err
  }
  const hit = router.match(method, url.pathname)
  if (hit === null) return unrouted(service, method, url.pathname)
  const st = rt.state(run).of(tenant)
  const ctx: Ctx<C> = {
    params: hit.params,
    query: url.searchParams,
    body: raw,
    run,
    tenant,
    db: rt.pool.client(run),
    clock: st.clock,
    minter: st.minter,
    headers,
    url,
    json: () => parseBody(raw),
  }
  return router.run(hit.spec, ctx)
}

export function createKitServer<C extends MinimalClient>(rt: Runtime<C>): Server {
  const { service, maxBodyBytes } = rt.fake.config
  const router = new Router<C>(rt.fake.routes())
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
        // Stop buffering, but let the request drain and answer from `end`.
        // Destroying the socket in the same tick as the write means the peer
        // reads ECONNRESET instead of the 413, so an over-large body looked
        // like a crashed server rather than a refused request.
        refused = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) {
        send(res, { status: 413, body: { error: 'body_too_large', limit: maxBodyBytes } }, false)
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
