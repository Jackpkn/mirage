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
import { makeReaddir, type EntryLister, type Guard, type Lister } from './readdir.ts'
import { Slot, Scope, makeDetectScope } from './scope.ts'

const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Scope({ kind: 'room', segments: ['rooms', new Slot('room')] }),
  new Scope({
    kind: 'note',
    segments: ['rooms', new Slot('room'), new Slot('note', JSON_NAME)],
    leaf: true,
    filetype: FileType.JSON,
  }),
]

const detectScope = makeDetectScope(SCOPES)

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
  const room = match.slots.room ?? ''
  accessor.calls.push(`notes:${room}`)
  return Promise.resolve(
    (TREE[room] ?? []).map((note): [string, IndexEntry] => [
      note,
      new IndexEntry({ id: note, name: note, resourceType: 'fake/note', vfsName: note, size: 7 }),
    ]),
  )
}

const roomGuard: Guard<FakeAccessor> = (accessor, match, virtual) => {
  const room = match.slots.room ?? ''
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

  it('drops dot-prefixed names from listings', async () => {
    // The classifier refuses every dot-leading segment, so a listing must
    // not advertise one (a quoted postgres schema can be named ".foo").
    const hiddenRooms: Lister<FakeAccessor> = async (accessor, match) => {
      const rooms = (await listRooms(accessor, match)) ?? []
      const entry = rooms[0]?.[1]
      if (entry === undefined) throw new Error('fixture rooms empty')
      return [['.secret', entry], ...rooms]
    }
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: hiddenRooms },
      staticRoot: ['rooms'],
    })
    const index = new RAMIndexCacheStore()
    const out = await readdir(new FakeAccessor(), spec('/rooms'), index)
    expect(out).toEqual(['/h/rooms/red', '/h/rooms/blue'])
    const cached = await index.listDir('/h/rooms')
    expect(cached.entries).toEqual(['/h/rooms/red', '/h/rooms/blue'])
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

const entryNotes: EntryLister<FakeAccessor> = (accessor, _match, entry) => {
  accessor.calls.push(`entry-notes:${entry.id}`)
  return Promise.resolve([
    [
      'note.json',
      new IndexEntry({
        id: entry.id,
        name: 'note.json',
        resourceType: 'fake/note',
        vfsName: 'note.json',
      }),
    ],
  ])
}

const ENTRY_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  entryListers: { room: entryNotes },
  staticRoot: ['rooms'],
})

describe('hierarchy makeReaddir entry listers', () => {
  it('resolves the directory through the parent listing', async () => {
    // The kit warms the parent listing once and hands the directory's own
    // entry to the lister; the lister never re-fetches its ancestors.
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await ENTRY_READDIR(accessor, spec('/rooms/red'), index)
    expect(out).toEqual(['/h/rooms/red/note.json'])
    expect(accessor.calls).toEqual(['rooms', 'entry-notes:red'])
    await ENTRY_READDIR(accessor, spec('/rooms/blue'), index)
    // The second room resolves from the already-cached rooms listing.
    expect(accessor.calls).toEqual(['rooms', 'entry-notes:red', 'entry-notes:blue'])
  })

  it('reports an unlisted container as ENOENT', async () => {
    const accessor = new FakeAccessor()
    await expect(ENTRY_READDIR(accessor, spec('/rooms/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(accessor.calls).toEqual(['rooms'])
  })

  it('works without an index', async () => {
    // A caller with no cache gets a call-local one, so the parent warm
    // still feeds the entry resolution.
    const out = await ENTRY_READDIR(new FakeAccessor(), spec('/rooms/red'))
    expect(out).toEqual(['/h/rooms/red/note.json'])
  })

  it('refuses a kind named in both lister tables at build', () => {
    expect(() =>
      makeReaddir<FakeAccessor>(detectScope, {
        listers: { room: listNotes },
        entryListers: { room: entryNotes },
        staticRoot: ['rooms'],
      }),
    ).toThrow('kinds in both lister tables')
  })
})
