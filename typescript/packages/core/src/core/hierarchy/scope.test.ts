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
import { FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import { Capture, Route } from './route.ts'
import { makeDetectScope } from './scope.ts'

const ROUTES: readonly Route[] = [
  new Route({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Route({ kind: 'room', segments: ['rooms', new Capture('room')] }),
  new Route({
    kind: 'note',
    segments: ['rooms', new Capture('room'), new Capture('note', JSON_NAME)],
    leaf: true,
    filetype: FileType.JSON,
  }),
]

const detectScope = makeDetectScope(ROUTES)

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    resourcePath: key,
  })
}

describe('hierarchy makeDetectScope', () => {
  it('classifies an empty key as root', () => {
    expect(detectScope('').kind).toBe('root')
    expect(detectScope('/').kind).toBe('root')
  })

  it('uses the mount path of a PathSpec operand', () => {
    const match = detectScope(spec('/rooms/red'))
    expect(match.kind).toBe('room')
    expect(match.captures).toEqual({ room: 'red' })
  })

  it('classifies hidden segments as invalid anywhere', () => {
    expect(detectScope('rooms/.red').kind).toBe('invalid')
    expect(detectScope('.rooms').kind).toBe('invalid')
  })

  it('classifies unmatched shapes as invalid', () => {
    expect(detectScope('rooms/red/a.json/deep').kind).toBe('invalid')
    expect(detectScope('halls').kind).toBe('invalid')
  })

  it('carries the route on a match', () => {
    const match = detectScope('rooms/red/a.json')
    expect(match.route).not.toBeNull()
    expect(match.route?.leaf).toBe(true)
    expect(detectScope('').route).toBeNull()
  })
})
