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
import {
  buildTree,
  computeNonemptyDirs,
  evalPredicate,
  expandPrintf,
  type FindEntry,
  keep,
  printfNeedsStat,
  treeHasType,
  displayPath,
  emitStartPath,
  prefixPathNodes,
  unrespellRaw,
} from './findEval.ts'

function entry(over: Partial<FindEntry> = {}): FindEntry {
  return { key: '/data/a.txt', name: 'a.txt', kind: 'f', depth: 1, ...over }
}

describe('empty', () => {
  it('empty node matches only isEmpty entries', () => {
    expect(evalPredicate({ op: 'empty' }, entry({ isEmpty: true }))).toBe(true)
    expect(evalPredicate({ op: 'empty' }, entry({ isEmpty: false }))).toBe(false)
    expect(evalPredicate({ op: 'empty' }, entry({}))).toBe(false)
  })

  it('buildTree empty combines with type', () => {
    const tree = buildTree({ type: 'd', empty: true })
    expect(evalPredicate(tree, entry({ kind: 'd', isEmpty: true }))).toBe(true)
    expect(evalPredicate(tree, entry({ kind: 'd', isEmpty: false }))).toBe(false)
    expect(evalPredicate(tree, entry({ kind: 'f', isEmpty: true }))).toBe(false)
  })

  it('computeNonemptyDirs', () => {
    const keys = ['/data', '/data/a.txt', '/data/sub', '/data/sub/x', '/data/emptydir']
    const ne = computeNonemptyDirs(keys)
    expect(ne.has('/data')).toBe(true)
    expect(ne.has('/data/sub')).toBe(true)
    expect(ne.has('/data/emptydir')).toBe(false)
  })
})

describe('evalPredicate', () => {
  it('name matches glob', () => {
    expect(evalPredicate({ op: 'name', pattern: '*.txt', icase: false }, entry())).toBe(true)
    expect(evalPredicate({ op: 'name', pattern: '*.md', icase: false }, entry())).toBe(false)
  })

  it('iname is case insensitive', () => {
    const e = entry({ name: 'A.TXT' })
    expect(evalPredicate({ op: 'name', pattern: '*.txt', icase: true }, e)).toBe(true)
    expect(evalPredicate({ op: 'name', pattern: '*.txt', icase: false }, e)).toBe(false)
  })

  it('path matches key', () => {
    const e = entry({ key: '/data/sub/x', name: 'x' })
    expect(evalPredicate({ op: 'path', pattern: '*/sub/*' }, e)).toBe(true)
    expect(evalPredicate({ op: 'path', pattern: '*/other/*' }, e)).toBe(false)
  })

  it('type matches kind', () => {
    expect(evalPredicate({ op: 'type', kind: 'f' }, entry({ kind: 'f' }))).toBe(true)
    expect(evalPredicate({ op: 'type', kind: 'd' }, entry({ kind: 'f' }))).toBe(false)
  })

  it('not negates', () => {
    expect(
      evalPredicate({ op: 'not', kid: { op: 'name', pattern: '*.txt', icase: false } }, entry()),
    ).toBe(false)
    expect(
      evalPredicate({ op: 'not', kid: { op: 'name', pattern: '*.md', icase: false } }, entry()),
    ).toBe(true)
  })

  it('and requires all', () => {
    const node = {
      op: 'and' as const,
      kids: [
        { op: 'name' as const, pattern: '*.txt', icase: false },
        { op: 'type' as const, kind: 'f' as const },
      ],
    }
    expect(evalPredicate(node, entry())).toBe(true)
  })

  it('or requires any', () => {
    const node = {
      op: 'or' as const,
      kids: [
        { op: 'name' as const, pattern: '*.md', icase: false },
        { op: 'name' as const, pattern: '*.txt', icase: false },
      ],
    }
    expect(evalPredicate(node, entry())).toBe(true)
  })

  it('true matches everything', () => {
    expect(evalPredicate({ op: 'true' }, entry())).toBe(true)
  })
})

describe('keep', () => {
  it('applies minDepth', () => {
    const e = entry({ depth: 1 })
    expect(keep(e, { op: 'true' }, null)).toBe(true)
    expect(keep(e, { op: 'true' }, 1)).toBe(true)
    expect(keep(e, { op: 'true' }, 2)).toBe(false)
  })
})

describe('buildTree', () => {
  it('empty options is true', () => {
    expect(evalPredicate(buildTree({}), entry())).toBe(true)
  })

  it('name and type', () => {
    const tree = buildTree({ name: '*.txt', type: 'f' })
    expect(evalPredicate(tree, entry({ kind: 'f' }))).toBe(true)
    expect(evalPredicate(tree, entry({ name: 'a.md', kind: 'f' }))).toBe(false)
    expect(evalPredicate(tree, entry({ kind: 'd' }))).toBe(false)
  })

  it('nameExclude is negated', () => {
    const tree = buildTree({ nameExclude: '*.txt' })
    expect(evalPredicate(tree, entry({ name: 'a.txt' }))).toBe(false)
    expect(evalPredicate(tree, entry({ name: 'a.md' }))).toBe(true)
  })

  it('orNames', () => {
    const tree = buildTree({ orNames: ['*.md', '*.txt'] })
    expect(evalPredicate(tree, entry({ name: 'a.txt' }))).toBe(true)
    expect(evalPredicate(tree, entry({ name: 'a.rst' }))).toBe(false)
  })

  it('iname', () => {
    const tree = buildTree({ iname: '*.txt' })
    expect(evalPredicate(tree, entry({ name: 'A.TXT' }))).toBe(true)
  })

  it('treeHasType', () => {
    expect(treeHasType({ op: 'type', kind: 'f' })).toBe(true)
    expect(treeHasType({ op: 'name', pattern: 'x', icase: false })).toBe(false)
    expect(
      treeHasType({
        op: 'and',
        kids: [
          { op: 'name', pattern: 'x', icase: false },
          { op: 'type', kind: 'd' },
        ],
      }),
    ).toBe(true)
    expect(treeHasType({ op: 'not', kid: { op: 'type', kind: 'f' } })).toBe(true)
    expect(treeHasType({ op: 'true' })).toBe(false)
  })
})

describe('prefixPathNodes', () => {
  it('matches -path against the display path (#396)', () => {
    const tree = prefixPathNodes({ op: 'path', pattern: '*data/sub*' }, '/data')
    expect(evalPredicate(tree, { key: '/sub', name: 'sub', kind: 'd', depth: 1 })).toBe(true)
    expect(evalPredicate(tree, { key: '/other', name: 'other', kind: 'd', depth: 1 })).toBe(false)
    const exact = prefixPathNodes({ op: 'path', pattern: '/data/sub' }, '/data')
    expect(evalPredicate(exact, { key: '/sub', name: 'sub', kind: 'd', depth: 1 })).toBe(true)
  })

  it('rewrites nested nodes and leaves root mounts untouched', () => {
    const tree = prefixPathNodes({ op: 'and', kids: [{ op: 'path', pattern: '/data/*' }] }, '/data')
    expect(evalPredicate(tree, { key: '/x', name: 'x', kind: 'f', depth: 1 })).toBe(true)
    const same: Parameters<typeof prefixPathNodes>[0] = { op: 'path', pattern: '*a*' }
    expect(prefixPathNodes(same, '')).toBe(same)
  })
})

describe('displayPath', () => {
  it('joins like applyMountPrefix', () => {
    expect(displayPath('', '/sub/x')).toBe('/sub/x')
    expect(displayPath('/data', '/sub/x')).toBe('/data/sub/x')
    expect(displayPath('/data', '/')).toBe('/data')
  })
})

describe('emitStartPath size on directories', () => {
  it('directory start contributes size 0: +N excludes, -N keeps (#318)', () => {
    const results: string[] = []
    emitStartPath(results, '/data', 'data', {
      kind: 'd',
      isEmpty: null,
      exists: true,
      tree: { op: 'true' },
      maxDepth: null,
      minDepth: null,
      minSize: 5,
      maxSize: null,
    })
    expect(results).toEqual([])
    emitStartPath(results, '/data', 'data', {
      kind: 'd',
      isEmpty: null,
      exists: true,
      tree: { op: 'true' },
      maxDepth: null,
      minDepth: null,
      minSize: null,
      maxSize: 5,
    })
    expect(results).toEqual(['/data'])
  })
})

describe('expandPrintf', () => {
  const stat = {
    size: 6,
    kind: 'f' as const,
    mtimeEpoch: 1786887930,
    mode: null,
    targetKind: null,
  }

  it('expands the path family', () => {
    const warnings: string[] = []
    expect(expandPrintf('%p|%P|%f|%h|%d\n', '/data/sub/b.txt', '/data', null, warnings)).toBe(
      '/data/sub/b.txt|sub/b.txt|b.txt|/data/sub|2\n',
    )
    expect(warnings).toEqual([])
  })

  it('expands the stat family', () => {
    const warnings: string[] = []
    expect(expandPrintf('%s %y %m %M\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '6 f 644 -rw-r--r--\n',
    )
    expect(
      expandPrintf(
        '%y %m\n',
        '/data/sub',
        '/data',
        { size: 0, kind: 'd', mtimeEpoch: 0, mode: null, targetKind: null },
        warnings,
      ),
    ).toBe('d 755\n')
  })

  it('renders a reported mode over the per-kind default', () => {
    const warnings: string[] = []
    expect(
      expandPrintf('%m %M\n', '/data/a.txt', '/data', { ...stat, mode: 0o600 }, warnings),
    ).toBe('600 -rw-------\n')
    expect(
      expandPrintf(
        '%m %M\n',
        '/data/sub',
        '/data',
        { size: 0, kind: 'd', mtimeEpoch: 0, mode: 0o700, targetKind: null },
        warnings,
      ),
    ).toBe('700 drwx------\n')
  })

  it('reports the target kind for %Y on a link, N when it dangles', () => {
    const warnings: string[] = []
    const link = { size: 5, kind: 'l' as const, mtimeEpoch: 0, mode: null, targetKind: null }
    expect(
      expandPrintf('%y %Y\n', '/data/lnk', '/data', { ...link, targetKind: 'd' }, warnings),
    ).toBe('l d\n')
    expect(
      expandPrintf('%y %Y\n', '/data/lnk', '/data', { ...link, targetKind: 'N' }, warnings),
    ).toBe('l N\n')
    expect(expandPrintf('%y %Y\n', '/data/a.txt', '/data', stat, warnings)).toBe('f f\n')
  })

  it('expands time directives in UTC', () => {
    const warnings: string[] = []
    expect(expandPrintf('%TY-%Tm-%Td\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '2026-08-16\n',
    )
    expect(expandPrintf('%T@\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '1786887930.0000000000\n',
    )
  })

  it('handles escapes and warns once per unknown directive', () => {
    const warnings: string[] = []
    expect(expandPrintf('A\\tB\\n', '/data/a.txt', '/data', null, warnings)).toBe('A\tB\n')
    expect(expandPrintf('%Q\n', '/data/a.txt', '/data', null, warnings)).toBe('%Q\n')
    expect(expandPrintf('%Q\n', '/data/a.txt', '/data', null, warnings)).toBe('%Q\n')
    expect(warnings).toEqual(["find: warning: unrecognized format directive '%Q'"])
  })

  it('renders the start row at depth 0', () => {
    const warnings: string[] = []
    expect(expandPrintf('%P|%d|%f\n', '/data', '/data', null, warnings)).toBe('|0|data\n')
  })
})

describe('unrespellRaw', () => {
  it('inverts respelling', () => {
    expect(unrespellRaw('./sub/x', '/data', '.')).toBe('/data/sub/x')
    expect(unrespellRaw('.', '/data', '.')).toBe('/data')
    expect(unrespellRaw('/data/x', '/data', '/data')).toBe('/data/x')
  })
})

describe('printfNeedsStat', () => {
  it('detects stat directives', () => {
    expect(printfNeedsStat('%s\n')).toBe(true)
    expect(printfNeedsStat('%TY\n')).toBe(true)
    expect(printfNeedsStat('%p %f %h %P %d\n')).toBe(false)
    expect(printfNeedsStat('100%%score\n')).toBe(false)
  })
})
