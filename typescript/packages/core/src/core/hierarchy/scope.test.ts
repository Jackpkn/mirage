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
import { Codec, INT_JSON, JSON_NAME } from './codec.ts'
import { Slot, Scope, makeDetectScope, matchScope } from './scope.ts'

const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Scope({ kind: 'room', segments: ['rooms', new Slot('room')] }),
  new Scope({
    kind: 'note',
    segments: ['rooms', new Slot('room'), new Slot('note', JSON_NAME)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Scope({
    kind: 'revision',
    segments: ['rooms', new Slot('room'), 'revisions', new Slot('rev', INT_JSON)],
    leaf: true,
    filetype: FileType.JSON,
  }),
  new Scope({
    kind: 'tagged',
    segments: ['tags', new Slot('tag', new Codec({ validate: (t) => t === t.toLowerCase() }))],
    leaf: true,
    filetype: FileType.TEXT,
  }),
]

const detectScope = makeDetectScope(SCOPES)

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    resourcePath: key,
  })
}

describe('hierarchy matchScope', () => {
  it('matches literal and slot segments in order', () => {
    const matched = matchScope(SCOPES, ['rooms', 'red', 'a.json'])
    expect(matched).not.toBeNull()
    const [scope, slots] = matched ?? [undefined, undefined]
    expect(scope?.kind).toBe('note')
    expect(slots).toEqual({ room: 'red', note: 'a' })
  })

  it('refuses a wrong length or literal', () => {
    expect(matchScope(SCOPES, ['halls'])).toBeNull()
    expect(matchScope(SCOPES, ['rooms', 'red', 'a.json', 'deep'])).toBeNull()
  })

  it('fails the whole scope on a codec failure', () => {
    expect(matchScope(SCOPES, ['rooms', 'red', 'revisions', 'x.json'])).toBeNull()
    const matched = matchScope(SCOPES, ['rooms', 'red', 'revisions', '3.json'])
    expect(matched?.[1]).toEqual({ room: 'red', rev: '3' })
  })

  it('applies a validated slot', () => {
    expect(matchScope(SCOPES, ['tags', 'ok'])).not.toBeNull()
    expect(matchScope(SCOPES, ['tags', 'NOPE'])).toBeNull()
  })

  it('splits an idKey slot on the last separator', () => {
    const idScopes: readonly Scope[] = [
      new Scope({
        kind: 'file',
        segments: ['owned', new Slot('name', new Codec({ suffix: '.json' }), 'file_id')],
        leaf: true,
      }),
    ]
    let matched = matchScope(idScopes, ['owned', '2024-01-05_Notes__abc12.json'])
    expect(matched?.[1]).toEqual({ name: '2024-01-05_Notes', file_id: 'abc12' })
    // A three-part label keeps everything before the LAST separator.
    matched = matchScope(idScopes, ['owned', 'KEY__name__id7.json'])
    expect(matched?.[1]).toEqual({ name: 'KEY__name', file_id: 'id7' })
    // Both halves are required.
    expect(matchScope(idScopes, ['owned', 'plain.json'])).toBeNull()
    expect(matchScope(idScopes, ['owned', '__id.json'])).toBeNull()
    expect(matchScope(idScopes, ['owned', 'label__.json'])).toBeNull()
  })
})

describe('hierarchy makeDetectScope', () => {
  it('classifies an empty key as root', () => {
    expect(detectScope('').kind).toBe('root')
    expect(detectScope('/').kind).toBe('root')
  })

  it('uses the mount path of a PathSpec operand', () => {
    const match = detectScope(spec('/rooms/red'))
    expect(match.kind).toBe('room')
    expect(match.slots).toEqual({ room: 'red' })
  })

  it('classifies hidden segments as invalid anywhere', () => {
    expect(detectScope('rooms/.red').kind).toBe('invalid')
    expect(detectScope('.rooms').kind).toBe('invalid')
  })

  it('classifies unmatched shapes as invalid', () => {
    expect(detectScope('rooms/red/a.json/deep').kind).toBe('invalid')
    expect(detectScope('halls').kind).toBe('invalid')
  })

  it('carries the scope on a match', () => {
    const match = detectScope('rooms/red/a.json')
    expect(match.scope).not.toBeNull()
    expect(match.scope?.leaf).toBe(true)
    expect(detectScope('').scope).toBeNull()
  })
})
