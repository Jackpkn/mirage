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

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveLanceDBConfig } from '../../resource/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import type { LanceDriver, LanceRow } from './_driver.ts'
import { readdir } from './readdir.ts'
import { renderCard } from './render.ts'

const ROW: LanceRow = {
  id: 1,
  label: 'cat',
  kind: 'big',
  name: 'a big orange cat',
}

const config = resolveLanceDBConfig({
  uri: '/tmp/db',
  groupBy: ['label', 'kind'],
  idColumn: 'id',
  titleColumn: 'name',
  blobColumn: 'image_bytes',
  blobExt: 'png',
  vectorColumn: 'vector',
})

function makeAccessor(): { accessor: LanceDBAccessor; rowsMatching: ReturnType<typeof vi.fn> } {
  const rowsMatching = vi.fn().mockResolvedValue([ROW])
  const driver = {
    listTables: vi.fn().mockResolvedValue(['animals']),
    tableColumns: vi
      .fn()
      .mockResolvedValue(['id', 'label', 'kind', 'name', 'image_bytes', 'vector']),
    distinct: vi.fn().mockResolvedValue(['big']),
    rowsMatching,
  } as unknown as LanceDriver
  return { accessor: new LanceDBAccessor(driver, config), rowsMatching }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: virtual.replace(/^\//, '') })
}

describe('lancedb readdir sizes', () => {
  it('selects every column except the vector and blob ones', async () => {
    const { accessor, rowsMatching } = makeAccessor()
    await readdir(accessor, spec('/animals/cat/big'), new RAMIndexCacheStore())
    expect(rowsMatching.mock.calls[0]?.[2]).toEqual(['id', 'label', 'kind', 'name'])
  })

  it('seeds the exact card size and leaves the blob unsized', async () => {
    const { accessor } = makeAccessor()
    const idx = new RAMIndexCacheStore()
    await readdir(accessor, spec('/animals/cat/big'), idx)
    const card = await idx.get('/animals/cat/big/1.md')
    expect(card.entry?.size).toBe(renderCard(ROW, config).byteLength)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBeNull()
  })

  it('lists without an index when none is given', async () => {
    const { accessor } = makeAccessor()
    const out = await readdir(accessor, spec('/animals/cat/big'))
    expect(out).toEqual(['/animals/cat/big/1.md', '/animals/cat/big/1.png'])
  })
})

const CAP = 5
const WIDE = 40

function wideAccessor(): {
  accessor: LanceDBAccessor
  rowsMatching: ReturnType<typeof vi.fn>
} {
  // The driver stands in for the store: the cap is a `limit` on the query, so
  // the fake applies the prefix and the limit in that order, exactly as the
  // SQL does.
  const rows: LanceRow[] = []
  for (let i = 0; i < WIDE; i += 1) rows.push({ id: `doc-${String(i).padStart(3, '0')}` })
  const rowsMatching = vi
    .fn()
    .mockImplementation(
      (_t: string, _f: unknown, _c: string[], limit: number, _id: string, prefix: string) =>
        Promise.resolve(rows.filter((r) => String(r.id).startsWith(prefix)).slice(0, limit)),
    )
  const driver = {
    listTables: vi.fn().mockResolvedValue(['wide']),
    tableColumns: vi.fn().mockResolvedValue(['id']),
    distinct: vi.fn().mockResolvedValue(['all']),
    rowsMatching,
  } as unknown as LanceDriver
  const wideConfig = resolveLanceDBConfig({
    uri: '/tmp/db',
    table: 'wide',
    groupBy: ['label'],
    idColumn: 'id',
    titleColumn: 'id',
    maxRows: CAP,
  })
  return { accessor: new LanceDBAccessor(driver, wideConfig), rowsMatching }
}

function globbed(virtual: string, pattern: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: virtual.replace(/^\//, ''),
    pattern,
  })
}

function ids(paths: string[]): string[] {
  return paths.map((p) => (p.split('/').pop() ?? '').split('.')[0] ?? '')
}

describe('lancedb readdir narrows a capped listing', () => {
  it('pushes a row glob prefix into the query', async () => {
    // The cap covers doc-000..doc-004, so filtering it would answer nothing.
    const { accessor, rowsMatching } = wideAccessor()
    const out = await readdir(accessor, globbed('/all', 'doc-03*'), new RAMIndexCacheStore())
    expect(ids(out)).toEqual(['doc-030', 'doc-031', 'doc-032', 'doc-033', 'doc-034'])
    expect(rowsMatching.mock.calls[0]?.[5]).toBe('doc-03')
  })

  it('cuts the prefix at the suffix so a leaf glob cannot ask for a dot', async () => {
    const { accessor, rowsMatching } = wideAccessor()
    await readdir(accessor, globbed('/all', 'doc-039.m*'), new RAMIndexCacheStore())
    expect(rowsMatching.mock.calls[0]?.[5]).toBe('doc-039')
  })

  it('sends no prefix for a glob with no literal head', async () => {
    const { accessor, rowsMatching } = wideAccessor()
    const out = await readdir(accessor, globbed('/all', '*9.md'), new RAMIndexCacheStore())
    expect(ids(out)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
    expect(rowsMatching.mock.calls[0]?.[5]).toBe('')
  })

  it('does not cache a narrowed listing as the directory', async () => {
    const { accessor } = wideAccessor()
    const idx = new RAMIndexCacheStore()
    await readdir(accessor, globbed('/all', 'doc-03*'), idx)
    const listed = await idx.listDir('/all/')
    expect(listed.entries === undefined || listed.entries === null).toBe(true)
    const plain = await readdir(accessor, spec('/all'), idx)
    expect(ids(plain)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
  })
})
