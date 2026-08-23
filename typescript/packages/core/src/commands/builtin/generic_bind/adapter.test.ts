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

import { stripSlash } from '../../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import type { Accessor } from '../../../accessor/base.ts'
import type { CommandOpts } from '../../config.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import {
  dirAwareStat,
  dirAwareStream,
  makeResolveGlob,
  withRuleGuard,
  type CommandIO,
} from './adapter.ts'
import { runWithAdmission } from '../../../context/session_context.ts'

const accessor = {} as never
// No namespace facts, which is what a command bound outside a workspace
// gets: the two probes below the backend are the only ones that can fire.
const NO_NS = {} as CommandOpts
// The one a mount parent needs: no backend row, a name plane that owes the
// path a child name.
function nsDir(dir: string): CommandOpts {
  return {
    ns: { childMounts: (parent: string) => (parent === dir ? ['alpha'] : []) },
  } as CommandOpts
}

function glob(dir: string, pattern: string): PathSpec {
  return new PathSpec({
    resourcePath: stripSlash(dir),
    virtual: dir,
    directory: dir,
    pattern,
    resolved: false,
  })
}

describe('makeResolveGlob', () => {
  it('expands a glob pattern against readdir', async () => {
    const readdir = () => Promise.resolve(['/d/a.txt', '/d/b.log', '/d/c.txt'])
    const resolveGlob = makeResolveGlob(readdir)
    const out = await resolveGlob(accessor, [glob('/d/', '*.txt')])
    expect(out.map((p) => p.virtual).sort()).toEqual(['/d/a.txt', '/d/c.txt'])
    expect(out.every((p) => p.resolved)).toBe(true)
  })

  it('passes an already-resolved path through unchanged', async () => {
    const readdir = () => Promise.reject(new Error('should not readdir'))
    const resolveGlob = makeResolveGlob(readdir)
    const p = new PathSpec({
      resourcePath: 'd/a.txt',
      virtual: '/d/a.txt',
      directory: '/d/',
      resolved: true,
    })
    const out = await resolveGlob(accessor, [p])
    expect(out).toEqual([p])
  })

  it('truncates matches beyond maxGlobMatches', async () => {
    const readdir = () => Promise.resolve(['/d/a.txt', '/d/b.txt', '/d/c.txt'])
    const resolveGlob = makeResolveGlob(readdir, 2)
    const out = await resolveGlob(accessor, [glob('/d/', '*.txt')])
    expect(out).toHaveLength(2)
  })

  it('passes a plain non-pattern unresolved path through', async () => {
    const readdir = () => Promise.reject(new Error('should not readdir'))
    const resolveGlob = makeResolveGlob(readdir)
    const p = new PathSpec({
      resourcePath: 'd/a.txt',
      virtual: '/d/a.txt',
      directory: '/d/',
      resolved: false,
    })
    const out = await resolveGlob(accessor, [p])
    expect(out).toEqual([p])
  })
})

// eslint-disable-next-line @typescript-eslint/require-await
async function* dataStream(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode('data')
}

function dirOps(implicitDirs: readonly string[], explicitDirs: readonly string[] = []): CommandIO {
  return {
    readdir: (_a, p) => {
      const target = `/${stripSlash(p.virtual)}`
      const entries = implicitDirs.filter((d) => (d.slice(0, d.lastIndexOf('/')) || '/') === target)
      if (implicitDirs.includes(p.virtual))
        entries.push(`${target === '/' ? '' : target}/child.txt`)
      return Promise.resolve(entries)
    },
    readBytes: () => Promise.resolve(new Uint8Array()),
    readStream: (_a, p) => {
      if (implicitDirs.includes(p.virtual)) throw enoent(p)
      return dataStream()
    },
    stat: (_a, p) => {
      if (implicitDirs.includes(p.virtual)) return Promise.reject(enoent(p))
      if (explicitDirs.includes(p.virtual))
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.DIRECTORY }))
      return Promise.resolve(new FileStat({ name: p.virtual, size: 0 }))
    },
    isMounted: () => true,
  }
}

describe('dirAwareStat', () => {
  it('refuses an implicit keyed-backend directory with EISDIR', async () => {
    const stat = dirAwareStat(dirOps(['/sub']), accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refuses a stat-typed directory with EISDIR', async () => {
    const stat = dirAwareStat(dirOps([], ['/sub']), accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps ENOENT for a genuinely missing path', async () => {
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a namespace-only mount parent with EISDIR', async () => {
    // No backend knows the path: its keys live in a mount nested under it,
    // so neither the stat nor the parent-listing probe can see it, and the
    // dispatcher is the only thing that can say it is a directory.
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor, nsDir('/ghost'))
    await expect(stat(PathSpec.fromStrPath('/ghost'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps ENOENT when the dispatcher does not know the path either', async () => {
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor, nsDir('/elsewhere'))
    await expect(stat(PathSpec.fromStrPath('/ghost'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores fabricated children from synthetic hierarchies', async () => {
    // A postgres-style backend answers a readdir of any missing name with
    // fabricated children; only the parent listing decides.
    const lying: CommandIO = {
      ...dirOps([]),
      stat: (_a, p) => Promise.reject(enoent(p)),
      readdir: (_a, p) => {
        const target = `/${stripSlash(p.virtual)}`
        if (target === '/') return Promise.resolve(['/real.txt'])
        return Promise.resolve([`${target}/tables`, `${target}/views`])
      },
    }
    const stat = dirAwareStat(lying, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps ENOENT when the probe readdir raises a driver error', async () => {
    const throwing: CommandIO = {
      ...dirOps([]),
      stat: (_a, p) => Promise.reject(enoent(p)),
      readdir: () => Promise.reject(new Error("Table 'nope.txt' was not found")),
    }
    const stat = dirAwareStat(throwing, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes regular files through', async () => {
    const stat = dirAwareStat(dirOps([]), accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/f.txt'))).resolves.toMatchObject({ size: 0 })
  })
})

describe('dirAwareStream', () => {
  it('refuses an implicit directory with EISDIR when consumed', async () => {
    const stream = dirAwareStream(dirOps(['/sub']), accessor, NO_NS)
    const consume = async () => {
      for await (const chunk of stream(PathSpec.fromStrPath('/sub'))) {
        throw new Error(`no data expected, got ${String(chunk.byteLength)} bytes`)
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refuses a stat-typed directory before the backend read runs', async () => {
    // sftp reads of a directory raise an opaque `Failure`; the stat-first
    // check must win so the generic formats GNU's `Is a directory`.
    const sshLike: CommandIO = {
      ...dirOps([], ['/sub']),
      readStream: () => {
        throw new Error('Failure')
      },
    }
    const stream = dirAwareStream(sshLike, accessor, NO_NS)
    const consume = async () => {
      for await (const chunk of stream(PathSpec.fromStrPath('/sub'))) {
        throw new Error(`no data expected, got ${String(chunk.byteLength)} bytes`)
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('streams regular files untouched', async () => {
    const stream = dirAwareStream(dirOps([]), accessor, NO_NS)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream(PathSpec.fromStrPath('/f.txt'))) chunks.push(chunk)
    expect(new TextDecoder().decode(chunks[0])).toBe('data')
  })
})

describe('withRuleGuard', () => {
  const spec = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
      resourcePath: virtual,
      resolved: true,
    })

  it('asks the bound gate and leaves stat alone', async () => {
    const calls: string[][] = []
    async function* stream(_a: Accessor, path: PathSpec): AsyncGenerator<Uint8Array> {
      calls.push(['stream', path.virtual])
      yield await Promise.resolve(new Uint8Array([1]))
    }
    const ops: CommandIO = {
      readdir: (_a, path) => {
        calls.push(['readdir', path.virtual])
        return Promise.resolve(['/data/locked/y'])
      },
      readBytes: (_a, path) => {
        calls.push(['read', path.virtual])
        return Promise.resolve(new Uint8Array([1]))
      },
      readStream: stream,
      stat: (_a, path) => {
        calls.push(['stat', path.virtual])
        return Promise.resolve(new FileStat({ name: 'k', type: FileType.TEXT, size: 1 }))
      },
      isMounted: () => true,
      rename: (_a, src, dst) => {
        calls.push(['rename', src.virtual, dst.virtual])
        return Promise.resolve()
      },
    }
    const guarded = withRuleGuard(ops)
    // No gate bound: every slot runs as is.
    expect(await guarded.readBytes(accessor, spec('/data/locked/y'))).toEqual(new Uint8Array([1]))
    const asked: string[] = []
    const gate = {
      scoped: true,
      granted: [],
      check: (virtual: string) => {
        asked.push(virtual)
        if (virtual === '/data/locked/y') throw new Error(`refused ${virtual}`)
      },
    }
    await runWithAdmission(gate, async () => {
      // The gate throws at call time, like the hidden guard, so a caller's
      // `await` inside a try sees it the same way as a rejection.
      expect(() => guarded.readBytes(accessor, spec('/data/locked/y'))).toThrow('refused')
      // stat is not a guarded slot: deny is present and refused.
      expect((await guarded.stat(accessor, spec('/data/locked/y'))).size).toBe(1)
      // readdir asks about the directory, never filters its names.
      expect(await guarded.readdir(accessor, spec('/data/locked'))).toEqual(['/data/locked/y'])
      // A pair op asks about both paths.
      const rename = guarded.rename
      if (rename === undefined) throw new Error('rename slot missing')
      expect(() => rename(accessor, spec('/data/a'), spec('/data/locked/y'))).toThrow('refused')
      await rename(accessor, spec('/data/a'), spec('/data/b'))
    })
    expect(asked).toEqual([
      '/data/locked/y',
      '/data/locked',
      '/data/a',
      '/data/locked/y',
      '/data/a',
      '/data/b',
    ])
    expect(calls).not.toContainEqual(['rename', '/data/a', '/data/locked/y'])
    expect(calls).toContainEqual(['rename', '/data/a', '/data/b'])
  })
})
