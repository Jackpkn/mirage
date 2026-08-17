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

import { describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolder: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec, type WalkEntry } from '../../types.ts'
import type { DropboxTokenManager } from './client.ts'
import * as api from './api.ts'
import { DropboxWalk } from './watch.ts'

const STUB_TM = {} as DropboxTokenManager

function accessor(rootPath: string): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM, rootPath })
}

function root(): PathSpec {
  return new PathSpec({ virtual: '/m', directory: '/m', resourcePath: '' })
}

async function collect(walk: DropboxWalk, at: PathSpec): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const entry of walk.walk(at)) out.push(entry)
  return out
}

describe('DropboxWalk root stripping', () => {
  it('strips the root when the server casing differs', async () => {
    // Dropbox paths are case-insensitive: path_display carries the
    // server's casing and rootPath the user's. Comparing them exactly
    // left the root on the front of every virtual path, which put every
    // event outside the watch scope and silently disabled delivery.
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'notes.txt',
        path_display: '/Team/notes.txt',
        path_lower: '/team/notes.txt',
        size: 4,
        rev: 'r1',
      },
    ])
    const entries = await collect(new DropboxWalk(accessor('/team')), root())
    expect(entries.map((e) => e.virtual)).toEqual(['/m/notes.txt'])
  })

  it('preserves the casing below the root', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'Report.TXT',
        path_display: '/Team/Notes/Report.TXT',
        path_lower: '/team/notes/report.txt',
        size: 4,
        rev: 'r1',
      },
    ])
    const entries = await collect(new DropboxWalk(accessor('/team')), root())
    expect(entries.map((e) => e.virtual)).toEqual(['/m/Notes/Report.TXT'])
  })
})
