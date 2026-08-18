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

import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { matchRoute, type Route } from './route.ts'

export const ROOT = 'root'
export const INVALID = 'invalid'

/**
 * Where in the hierarchy a path landed.
 *
 * `kind` is the matched route's kind, or `root`/`invalid`. `captures` holds
 * the decoded dynamic segments by name. `resourcePath` is the raw path that
 * was classified. `route` is the matched route; null for root and invalid.
 */
export interface RouteMatch {
  readonly kind: string
  readonly resourcePath: string
  readonly captures: Record<string, string>
  readonly route: Route | null
}

export type DetectFn = (path: PathSpec | string) => RouteMatch

/**
 * Build a path classifier from a route table.
 *
 * The classifier is the single description of the backend's tree: readdir,
 * stat, read, and any search push-down all dispatch on its result, so the
 * file surface and the command surface cannot disagree about what a path
 * means. Hidden segments classify as invalid, which every consumer turns
 * into ENOENT. Routes are matched in declaration order.
 */
export function makeDetectScope(routes: readonly Route[]): DetectFn {
  return function detectScope(path: PathSpec | string): RouteMatch {
    const raw = path instanceof PathSpec ? path.mountPath : path
    const key = stripSlash(raw)
    if (key === '') return { kind: ROOT, resourcePath: raw, captures: {}, route: null }
    const parts = key.split('/')
    if (parts.some((p) => p.startsWith('.'))) {
      return { kind: INVALID, resourcePath: raw, captures: {}, route: null }
    }
    const matched = matchRoute(routes, parts)
    if (matched === null) return { kind: INVALID, resourcePath: raw, captures: {}, route: null }
    const [route, captures] = matched
    return { kind: route.kind, resourcePath: raw, captures, route }
  }
}
