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
import { FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import { makeRead, type Reader } from './read.ts'
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

const readNote: Reader<FakeAccessor> = (_accessor, match, _path, _index) =>
  Promise.resolve(
    new TextEncoder().encode(`${match.captures.room ?? ''}:${match.captures.note ?? ''}`),
  )

const READ = makeRead<FakeAccessor>(detectScope, { note: readNote })

describe('hierarchy makeRead', () => {
  it('hands the reader the captures', async () => {
    const out = await READ(new FakeAccessor(), spec('/rooms/red/a.json'))
    expect(new TextDecoder().decode(out)).toBe('red:a')
  })

  it('answers everything else with ENOENT', async () => {
    for (const path of ['/', '/rooms', '/rooms/red', '/rooms/.red/a.json', '/halls']) {
      await expect(READ(new FakeAccessor(), spec(path))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  })
})
