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

import { PathSpec } from '@struktoai/mirage-core/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { exists as pathExists } from './exists.ts'
import { dirStatEntry, keyOf, lookup, probeDir, probeFile } from './lookup.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { parseEntry } from './tree.ts'

function ps(path: string, prefix = ''): PathSpec {
  const rel = path.replace(/^\/+|\/+$/g, '')
  const stem = prefix.replace(/\/+$/, '')
  const virtual =
    stem === '' ? (rel === '' ? '/' : `/${rel}`) : rel === '' ? stem : `${stem}/${rel}`
  const parent = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  return new PathSpec({ virtual, directory: parent, resourcePath: rel })
}

/** The errno an fs op refused with, which is what a backend test pins. */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

function loaded(): HfHubAccessor {
  const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
  accessor.tree = new Map([
    ['a.txt', parseEntry({ type: 'file', oid: 'oid-a', size: 7, path: 'a.txt' })],
    ['d/b.txt', parseEntry({ type: 'file', oid: 'oid-b', size: 3, path: 'd/b.txt' })],
    ['d', parseEntry({ type: 'directory', oid: 'tree-d', size: 0, path: 'd' })],
  ])
  accessor.treeLoaded = true
  accessor.rowsCache = null
  return accessor
}

describe('keyOf', () => {
  it.each([
    ['', 'a.txt', '/a.txt'],
    ['', '', '/'],
    ['/m', 'a.txt', '/m/a.txt'],
    ['/m', '', '/m'],
    ['/m', '/d/a.txt', '/m/d/a.txt'],
  ])('prefix %s + %s', (prefix, local, expected) => {
    expect(keyOf(prefix, local)).toBe(expected)
  })
})

describe('lookup', () => {
  it('answers from the tree without an index', async () => {
    const found = await lookup(loaded(), undefined, '', '/a.txt')
    expect(found.entry?.size).toBe(7)
  })

  it('reports a directory with no row of its own', async () => {
    const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
    accessor.tree = new Map([
      ['d/b.txt', parseEntry({ type: 'file', oid: 'o', size: 1, path: 'd/b.txt' })],
    ])
    accessor.treeLoaded = true
    const found = await lookup(accessor, undefined, '', '/d')
    expect(found.entry).toBeNull()
    expect(found.children).toEqual(['/d/b.txt'])
  })

  it('reports an absence', async () => {
    const found = await lookup(loaded(), undefined, '', '/nope')
    expect(found.entry).toBeNull()
    expect(found.children).toBeNull()
  })
})

describe('probes', () => {
  it('tell a file from a directory', async () => {
    const accessor = loaded()
    expect(await probeFile(accessor, undefined, '', 'a.txt')).toBe(true)
    expect(await probeDir(accessor, undefined, '', 'a.txt')).toBe(false)
    expect(await probeDir(accessor, undefined, '', 'd')).toBe(true)
    expect(await probeFile(accessor, undefined, '', 'nope')).toBe(false)
  })
})

describe('dirStatEntry', () => {
  it('names the last segment', () => {
    const entry = dirStatEntry('/m/deep/dir')
    expect(entry.name).toBe('dir')
    expect(entry.resourceType).toBe('folder')
  })
})

describe('readdir', () => {
  it('lists the root and a subdirectory', async () => {
    const accessor = loaded()
    expect(await readdir(accessor, ps(''))).toEqual(['/a.txt', '/d'])
    expect(await readdir(accessor, ps('d'))).toEqual(['/d/b.txt'])
  })

  it('reports ENOTDIR for a file and for a path under one', async () => {
    // GNU `ls /f.txt/x` reports Not a directory, not absence. The FsError
    // carries the code; the strerror suffix is appended at the command
    // chokepoints, so the code is what a backend test can pin.
    const accessor = loaded()
    expect(await codeOf(() => readdir(accessor, ps('a.txt')))).toBe('ENOTDIR')
    expect(await codeOf(() => readdir(accessor, ps('a.txt/x')))).toBe('ENOTDIR')
  })

  it('reports ENOENT for a missing path however deep', async () => {
    const accessor = loaded()
    expect(await codeOf(() => readdir(accessor, ps('nope')))).toBe('ENOENT')
    expect(await codeOf(() => readdir(accessor, ps('nope/deeper')))).toBe('ENOENT')
  })

  it('lists nothing for an empty repo', async () => {
    const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
    accessor.treeLoaded = true
    expect(await readdir(accessor, ps(''))).toEqual([])
  })
})

describe('stat', () => {
  it('reports size and the oid as fingerprint', async () => {
    const result = await stat(loaded(), ps('a.txt'))
    expect(result.size).toBe(7)
    expect(result.fingerprint).toBe('oid-a')
  })

  it('leaves mtime null when the row carries none', async () => {
    // A Hub file's only mtime is its last commit, and a bare listing carries
    // none. Null is honest; a repo-wide timestamp on every file would not be.
    expect((await stat(loaded(), ps('a.txt'))).modified).toBeNull()
  })

  it('reports the mount root as a directory', async () => {
    const result = await stat(loaded(), ps(''))
    expect(result.name).toBe('/')
    expect(result.type).toBe('directory')
  })

  it('reports ENOENT for a missing path', async () => {
    expect(await codeOf(() => stat(loaded(), ps('nope')))).toBe('ENOENT')
  })
})

describe('read', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('never reaches the network for a path the listing knows is absent', async () => {
    const spy = vi.spyOn(client, 'hubBytes')
    expect(await codeOf(() => read(loaded(), ps('nope')))).toBe('ENOENT')
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports EISDIR for a directory and for the mount root', async () => {
    const accessor = loaded()
    expect(await codeOf(() => read(accessor, ps('d')))).toBe('EISDIR')
    expect(await codeOf(() => read(accessor, ps('')))).toBe('EISDIR')
  })

  it('fetches the resolve url', async () => {
    const spy = vi.spyOn(client, 'hubBytes').mockResolvedValue(new TextEncoder().encode('hello'))
    const data = await read(loaded(), ps('a.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
    expect(spy.mock.calls[0]?.[1]).toBe('https://huggingface.co/acme/widget/resolve/main/a.txt')
    expect(spy.mock.calls[0]?.[2]).toBeUndefined()
  })

  it('passes a byte window', async () => {
    const spy = vi.spyOn(client, 'hubBytes').mockResolvedValue(new Uint8Array(2))
    await read(loaded(), ps('a.txt'), undefined, { offset: 0, size: 2 })
    expect(spy.mock.calls[0]?.[2]).toEqual({ offset: 0, size: 2 })
  })
})

describe('exists', () => {
  it('is true for a file and a directory, false for an absence', async () => {
    const accessor = loaded()
    expect(await pathExists(accessor, ps('a.txt'))).toBe(true)
    expect(await pathExists(accessor, ps('d'))).toBe(true)
    expect(await pathExists(accessor, ps('nope'))).toBe(false)
  })
})
