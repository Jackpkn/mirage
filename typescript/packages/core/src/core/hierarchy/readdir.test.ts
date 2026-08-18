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
import { Accessor } from '../../accessor/base.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import { makeReaddir, type Guard, type Lister } from './readdir.ts'
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

const TREE: Record<string, string[]> = {
  rooms: ['red', 'blue'],
  red: ['a.json', 'b.json'],
  blue: [],
}

class FakeAccessor extends Accessor {
  readonly calls: string[] = []
}

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    resourcePath: key,
  })
}

const listRooms: Lister<FakeAccessor> = (accessor, _match) => {
  accessor.calls.push('rooms')
  return Promise.resolve(
    (TREE.rooms ?? []).map((room): [string, IndexEntry] => [
      room,
      new IndexEntry({ id: room, name: room, resourceType: 'fake/room', vfsName: room }),
    ]),
  )
}

const listNotes: Lister<FakeAccessor> = (accessor, match) => {
  const room = match.captures.room ?? ''
  accessor.calls.push(`notes:${room}`)
  return Promise.resolve(
    (TREE[room] ?? []).map((note): [string, IndexEntry] => [
      note,
      new IndexEntry({ id: note, name: note, resourceType: 'fake/note', vfsName: note, size: 7 }),
    ]),
  )
}

const roomGuard: Guard<FakeAccessor> = (accessor, match, virtual) => {
  const room = match.captures.room ?? ''
  accessor.calls.push(`guard:${room}`)
  if (!(TREE.rooms ?? []).includes(room)) return Promise.reject(enoent(virtual))
  return Promise.resolve()
}

const READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: {
    rooms: listRooms,
    room: listNotes,
  },
  staticRoot: ['rooms'],
  guards: { room: roomGuard },
})

describe('hierarchy makeReaddir', () => {
  it('lists a static root without any call', async () => {
    const accessor = new FakeAccessor()
    expect(await READDIR(accessor, spec('/'))).toEqual(['/h/rooms'])
    expect(accessor.calls).toEqual([])
  })

  it('joins names under the virtual key at a dynamic level', async () => {
    const accessor = new FakeAccessor()
    expect(await READDIR(accessor, spec('/rooms'))).toEqual(['/h/rooms/red', '/h/rooms/blue'])
  })

  it('runs the guard before the index probe', async () => {
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    await READDIR(accessor, spec('/rooms/red'), index)
    await READDIR(accessor, spec('/rooms/red'), index)
    // Two guard calls, one lister call: the second hit was served from the
    // index but still had to prove the room exists.
    expect(accessor.calls).toEqual(['guard:red', 'notes:red', 'guard:red'])
  })

  it('turns a guard failure into ENOENT even for a listable shape', async () => {
    await expect(READDIR(new FakeAccessor(), spec('/rooms/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses leaf and invalid paths', async () => {
    await expect(READDIR(new FakeAccessor(), spec('/rooms/red/a.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(READDIR(new FakeAccessor(), spec('/halls'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('can answer a leaf with ENOTDIR', async () => {
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: listRooms },
      staticRoot: ['rooms'],
      leafError: 'enotdir',
    })
    await expect(readdir(new FakeAccessor(), spec('/rooms/red/a.json'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})
