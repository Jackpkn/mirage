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

import type { Clock } from './clock.ts'
import type { Minter } from './mint.ts'
import { RouteError } from './errors.ts'
import type { Headers } from './tenant.ts'
import type { JsonValue, Reply, RouteMatch } from './types.ts'

// The per-request context. It is `RouteMatch` (params, query, body, run,
// tenant) plus the four things every handler reached for by hand in the old
// fakes: the run's client, the clock, the minter, and the raw headers.
export interface Ctx<C> extends RouteMatch {
  db: C
  clock: Clock
  minter: Minter
  headers: Headers
  url: URL
  json: () => JsonValue
}

export type KitHandler<C> = (ctx: Ctx<C>) => Promise<Reply> | Reply

export interface KitRoute<C> {
  method: string
  path: string
  pattern: RegExp
  params: string[]
  handler: KitHandler<C>
  write: boolean
}

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g
// A wildcard segment, `*name`, captures the REST of the path including its
// slashes. `:name` deliberately does not, and that is right for a vendor that
// addresses items by id; Microsoft Graph addresses them by PATH, wedged into
// the URL between `/root:` and `:/`, so a route for it cannot be written with
// slash-free parameters at all.
const SPLAT_RE = /\\\*([A-Za-z_][A-Za-z0-9_]*)/g
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g

export function compilePath(path: string): { pattern: RegExp; params: string[] } {
  if (!path.startsWith('/')) throw new RouteError(`route path must start with /: ${path}`)
  const params: string[] = []
  // Escaping runs first, so a `*` in the source is `\\*` by the time the
  // wildcard pattern looks for it; both replacements run in ONE pass so their
  // names are pushed left to right, which is the order the matcher reads the
  // capture groups back.
  const both = new RegExp(`${SPLAT_RE.source}|${PARAM_RE.source}`, 'g')
  const body = path
    .replace(ESCAPE_RE, '\\$&')
    .replace(both, (_all, splat: string | undefined, name: string | undefined) => {
      if (splat !== undefined) {
        params.push(splat)
        return '(.*)'
      }
      params.push(name ?? '')
      return '([^/]+)'
    })
  // No `/?` here. A vendor API answers the path it documents, not that path
  // with a trailing slash, and the fakes this kit replaces 404'd on one. The
  // permissive spelling made every route match both, which is a divergence on
  // every service at once (discord's /users/@me/guilds/ was 200 here and 404
  // on the python fake). A fake that genuinely wants both declares both.
  return { pattern: new RegExp(`^${body}$`), params }
}

export function route<C>(
  method: string,
  path: string,
  handler: KitHandler<C>,
  opts: { write?: boolean } = {},
): KitRoute<C> {
  const { pattern, params } = compilePath(path)
  return {
    method: method.toUpperCase(),
    path,
    pattern,
    params,
    handler,
    write: opts.write === true,
  }
}

export interface Matched<C> {
  spec: KitRoute<C>
  params: Record<string, string>
}

export class Router<C> {
  private readonly routes: KitRoute<C>[]
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(routes: KitRoute<C>[]) {
    this.routes = routes
  }

  match(method: string, pathname: string): Matched<C> | null {
    const want = method.toUpperCase()
    for (const spec of this.routes) {
      if (spec.method !== want && !(want === 'HEAD' && spec.method === 'GET')) continue
      const m = spec.pattern.exec(pathname)
      if (m === null) continue
      const params: Record<string, string> = {}
      spec.params.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] ?? '')
      })
      return { spec, params }
    }
    return null
  }

  // Generalizes notion_server.ts's serialize(). One event loop answers every
  // request, so two writes to the same rows interleave at any await: both
  // read, both write back, the later one silently drops the earlier change.
  //
  // The queue key is the RUN, not (run, tenant), because the run is what owns
  // mutable state: one SQLite file, one clock and one minter, all shared by
  // every tenant in it. Keying finer than the state it protects is not a
  // smaller lock, it is a missing one -- two tenants then minted from one
  // counter concurrently and their ids interleaved non-deterministically.
  enqueue<T>(run: string, work: () => Promise<T> | T): Promise<T> {
    const prior = this.queues.get(run) ?? Promise.resolve()
    const next = prior.then(work)
    this.queues.set(
      run,
      next.catch(() => null),
    )
    return next
  }

  // A read WAITS for the writes already queued on its run, but does not JOIN
  // the queue. Both halves matter. Waiting, because every migrated write
  // handler spans several awaited Prisma calls and the rows are inconsistent
  // in between: a read that started immediately answered from the middle of
  // one (probed: a transfer handler observed with 50 of 100 units in flight).
  // Not joining, because a read is a predecessor for nothing -- two reads
  // behind the same write still run concurrently, and the next write does not
  // queue behind them.
  run(spec: KitRoute<C>, ctx: Ctx<C>): Promise<Reply> {
    if (spec.write) return this.enqueue(ctx.run, () => spec.handler(ctx))
    const pending = this.queues.get(ctx.run)
    if (pending === undefined) return Promise.resolve(spec.handler(ctx))
    return pending.then(() => spec.handler(ctx))
  }

  async drain(): Promise<void> {
    await Promise.all([...this.queues.values()])
  }
}
