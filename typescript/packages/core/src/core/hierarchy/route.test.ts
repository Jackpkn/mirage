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

import { describe, expect, it } from 'vitest'
import { FileType } from '../../types.ts'
import { Codec, INT_JSON, JSON_NAME } from './codec.ts'
import { Capture, Route, matchRoute } from './route.ts'

const ROUTES: readonly Route[] = [
  new Route({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Route({ kind: 'room', segments: ['rooms', new Capture('room')] }),
  new Route({
    kind: 'note',
    segments: ['rooms', new Capture('room'), new Capture('note', JSON_NAME)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Route({
    kind: 'revision',
    segments: ['rooms', new Capture('room'), 'revisions', new Capture('rev', INT_JSON)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Route({
    kind: 'tagged',
    segments: ['tags', new Capture('tag', new Codec({ validate: (t) => t === t.toLowerCase() }))],
    leaf: true,
    filetype: FileType.TEXT,
  }),
]

describe('hierarchy matchRoute', () => {
  it('matches literal and capture segments in order', () => {
    const matched = matchRoute(ROUTES, ['rooms', 'red', 'a.json'])
    expect(matched).not.toBeNull()
    const [route, captures] = matched ?? [undefined, undefined]
    expect(route?.kind).toBe('note')
    expect(captures).toEqual({ room: 'red', note: 'a' })
  })

  it('refuses a wrong length or literal', () => {
    expect(matchRoute(ROUTES, ['halls'])).toBeNull()
    expect(matchRoute(ROUTES, ['rooms', 'red', 'a.json', 'deep'])).toBeNull()
  })

  it('fails the whole route on a codec failure', () => {
    expect(matchRoute(ROUTES, ['rooms', 'red', 'revisions', 'x.json'])).toBeNull()
    const matched = matchRoute(ROUTES, ['rooms', 'red', 'revisions', '3.json'])
    expect(matched?.[1]).toEqual({ room: 'red', rev: '3' })
  })

  it('applies a validated capture', () => {
    expect(matchRoute(ROUTES, ['tags', 'ok'])).not.toBeNull()
    expect(matchRoute(ROUTES, ['tags', 'NOPE'])).toBeNull()
  })
})
