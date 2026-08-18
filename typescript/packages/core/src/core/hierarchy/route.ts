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

import type { FileType } from '../../types.ts'
import { RAW, type Codec } from './codec.ts'

/** One dynamic segment of a route: the key the decoded value is stored under, and how the segment encodes it. */
export class Capture {
  readonly name: string
  readonly codec: Codec

  constructor(name: string, codec: Codec = RAW) {
    this.name = name
    this.codec = codec
  }
}

/**
 * One addressable position in a fixed API hierarchy.
 *
 * `kind` is the position's name; listers, probes and readers key on it.
 * `segments` is the path shape, literals and captures. `leaf` marks a file
 * rather than a directory, `filetype` its rendered type. `probed` is whether
 * stat must prove existence (parent listing by default); false for positions
 * that exist by construction, like the top-level directories.
 */
export class Route {
  readonly kind: string
  readonly segments: readonly (string | Capture)[]
  readonly leaf: boolean
  readonly filetype: FileType | null
  readonly probed: boolean

  constructor(init: {
    kind: string
    segments: readonly (string | Capture)[]
    leaf?: boolean
    filetype?: FileType
    probed?: boolean
  }) {
    this.kind = init.kind
    this.segments = init.segments
    this.leaf = init.leaf ?? false
    this.filetype = init.filetype ?? null
    this.probed = init.probed ?? true
  }
}

/** Match path segments against the table, first declared route wins. */
export function matchRoute(
  routes: readonly Route[],
  parts: readonly string[],
): [Route, Record<string, string>] | null {
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue
    const captures: Record<string, string> = {}
    let matched = true
    for (const [i, segment] of route.segments.entries()) {
      const part = parts[i] ?? ''
      if (typeof segment === 'string') {
        if (part !== segment) {
          matched = false
          break
        }
        continue
      }
      const decoded = segment.codec.decode(part)
      if (decoded === null) {
        matched = false
        break
      }
      captures[segment.name] = decoded
    }
    if (matched) return [route, captures]
  }
  return null
}
