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

import { RouteError } from '../../kit/typescript/index.ts'
import type { KitHandler, KitRoute } from '../../kit/typescript/index.ts'

// gws's own path compiler, because the kit's differs from the regexes this
// fake is a port of in two ways that are both observable.
//
// 1. The kit compiles `^...\/?$`, so every route also answers with a trailing
//    slash: `GET /drive/v3/files/` returned the whole file list where the old
//    regex (a bare `$`) answered `Unknown route`. A fake that answers a URL
//    the real API does not is a fake that hides a client bug.
// 2. Every kit parameter is `([^/]+)`, where the old fake used two classes on
//    purpose. A resource id was `[^/:]+` so that a path holding an in-segment
//    verb could never be read as an id, and only the segments that really can
//    hold a colon (an A1 range, a `<id>:batchUpdate` target) were wider. A
//    Sheets range was wider still, `(.+)`, because the range is the rest of
//    the path.
//
// So a route names the class per parameter and the default is the kit's.
export type ParamClass = 'id' | 'seg' | 'rest'

const CLASSES: Record<ParamClass, string> = {
  id: '([^/:]+)',
  seg: '([^/]+)',
  rest: '(.+)',
}

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g

export interface RouteOpts {
  write?: boolean
  classes?: Record<string, ParamClass>
}

export function route<C>(
  method: string,
  path: string,
  handler: KitHandler<C>,
  opts: RouteOpts = {},
): KitRoute<C> {
  if (!path.startsWith('/')) throw new RouteError(`route path must start with /: ${path}`)
  const params: string[] = []
  const classes = opts.classes ?? {}
  const body = path.replace(ESCAPE_RE, '\\$&').replace(PARAM_RE, (_all, name: string) => {
    params.push(name)
    return CLASSES[classes[name] ?? 'seg']
  })
  return {
    method: method.toUpperCase(),
    path,
    pattern: new RegExp(`^${body}$`),
    params,
    handler,
    write: opts.write === true,
  }
}
