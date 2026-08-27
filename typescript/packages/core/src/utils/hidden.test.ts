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
  classifyPaths,
  classifyShows,
  classifyVars,
  hideDepth,
  hidesIntersect,
  isGlob,
  moveReveals,
  pathCovers,
  pathHidden,
  pathVisible,
  showDepth,
  showHead,
  shownMode,
  varHidden,
} from './hidden.ts'
import { MountMode } from '../types.ts'

describe('pathHidden', () => {
  it('null and empty specs hide nothing', () => {
    expect(pathHidden(null, '/a/b')).toBe(false)
    expect(pathHidden({}, '/a/b')).toBe(false)
  })

  it('an exact path hides itself and its subtree', () => {
    // A name you cannot see cannot be a parent you traverse, so hiding
    // a path always hides everything under it.
    const h = { paths: ['/s3/secrets'] }
    expect(pathHidden(h, '/s3/secrets')).toBe(true)
    expect(pathHidden(h, '/s3/secrets/a.txt')).toBe(true)
    expect(pathHidden(h, '/s3/secrets/deep/b')).toBe(true)
    expect(pathHidden(h, '/s3')).toBe(false)
    expect(pathHidden(h, '/s3/secretsfoo')).toBe(false)
  })

  it('exact path spellings are normalized', () => {
    expect(pathHidden({ paths: ['/s3/secrets/'] }, '/s3/secrets')).toBe(true)
    expect(pathHidden({ paths: ['s3/secrets'] }, '/s3/secrets/a')).toBe(true)
  })

  it('an exact path at a mount root covers the mount', () => {
    const h = { paths: ['/s3'] }
    expect(pathHidden(h, '/s3/any/depth')).toBe(true)
    expect(pathHidden(h, '/other')).toBe(false)
  })

  it('a component pattern applies inside every mount', () => {
    const h = { patterns: ['*.key'] }
    expect(pathHidden(h, '/a/b.key')).toBe(true)
    expect(pathHidden(h, '/other/deep/c.key')).toBe(true)
    expect(pathHidden(h, '/a/b.key/inside.txt')).toBe(true)
    expect(pathHidden(h, '/a/bkey')).toBe(false)
    expect(pathHidden(h, '/a/keyed')).toBe(false)
  })

  it('an anchored pattern matches the full virtual path', () => {
    const h = { patterns: ['/config/*.pem'] }
    expect(pathHidden(h, '/config/x.pem')).toBe(true)
    expect(pathHidden(h, '/config/x.pem/sub')).toBe(true)
    expect(pathHidden(h, '/other/x.pem')).toBe(false)
  })

  it('anchored star crosses slashes like find -path', () => {
    expect(pathHidden({ patterns: ['/config/*.pem'] }, '/config/nested/x.pem')).toBe(true)
  })

  it('patterns share the repo fnmatch dialect', () => {
    // [^...] negates like [!...] (bash/glibc).
    const h = { patterns: ['[^a]*.key'] }
    expect(pathHidden(h, '/x/b.key')).toBe(true)
    expect(pathHidden(h, '/x/a.key')).toBe(false)
  })
})

describe('varHidden', () => {
  it('null hides nothing', () => {
    expect(varHidden(null, 'SECRET')).toBe(false)
  })

  it('names are exact', () => {
    const h = { names: ['SLACK_TOKEN'] }
    expect(varHidden(h, 'SLACK_TOKEN')).toBe(true)
    expect(varHidden(h, 'SLACK_TOKEN2')).toBe(false)
  })

  it('patterns are globs over names', () => {
    const h = { patterns: ['AWS_*', '*_SECRET'] }
    expect(varHidden(h, 'AWS_ACCESS_KEY_ID')).toBe(true)
    expect(varHidden(h, 'DB_SECRET')).toBe(true)
    expect(varHidden(h, 'HOME')).toBe(false)
  })
})

describe('classifyPaths / classifyVars', () => {
  it('splits globs from exact subtrees, in the order written', () => {
    expect(classifyPaths(['/repo/.env', '*.pem', '/repo/docs/*', 'secrets'])).toEqual({
      paths: ['/repo/.env', 'secrets'],
      patterns: ['*.pem', '/repo/docs/*'],
    })
    expect(isGlob('/a/b[1]')).toBe(true)
    expect(isGlob('/a/?')).toBe(true)
    expect(isGlob('/a/b')).toBe(false)
  })

  it('empty is unrestricted', () => {
    expect(classifyPaths([])).toBeNull()
    expect(classifyVars([])).toBeNull()
  })

  it('splits variable globs from names', () => {
    expect(classifyVars(['SLACK_TOKEN', 'AWS_*'])).toEqual({
      names: ['SLACK_TOKEN'],
      patterns: ['AWS_*'],
    })
  })

  it('classified entries match like a hand-built spec', () => {
    const spec = classifyPaths(['/s3/secrets', '*.key', '/repo/docs/*'])
    expect(pathHidden(spec, '/s3/secrets/deep/b')).toBe(true)
    expect(pathHidden(spec, '/a/b.key/c')).toBe(true)
    expect(pathHidden(spec, '/repo/docs/x/y')).toBe(true)
    expect(pathHidden(spec, '/repo/docsx')).toBe(false)
  })
})

describe('pathCovers', () => {
  it('is the directory holding the scope or an ancestor', () => {
    const spec = { paths: ['/s3/secrets'], patterns: ['/repo/docs/*', '*.pem'] }
    // An exact entry is covered by itself and by every ancestor; an
    // anchored pattern by its fixed head and that head's ancestors.
    for (const virtual of ['/s3/secrets', '/s3', '/', '/repo/docs', '/repo']) {
      expect(pathCovers(spec, virtual)).toBe(true)
    }
    for (const virtual of ['/s3/secrets/a', '/s3/other', '/repo/docs/x', '/x']) {
      expect(pathCovers(spec, virtual)).toBe(false)
    }
    // Without ancestors only the holding directory counts (a destination).
    expect(pathCovers(spec, '/repo/docs', false)).toBe(true)
    expect(pathCovers(spec, '/repo', false)).toBe(false)
    // A component pattern names no place, so nothing is covered by it.
    expect(pathCovers({ paths: [], patterns: ['*.pem'] }, '/x')).toBe(false)
    expect(pathCovers(null, '/')).toBe(false)
  })
})

describe('hideDepth', () => {
  it('scores the entry, never the match site', () => {
    const spec = classifyPaths(['/repo', '/repo/sealed/*', '*.pem'])
    expect(hideDepth(spec, '/repo/a/b/c')).toBe(1)
    expect(hideDepth(spec, '/repo/sealed/x/deep')).toBe(2)
    expect(hideDepth(classifyPaths(['*.pem']), '/x/k.pem/y')).toBe(0)
    expect(hideDepth(spec, '/other')).toBeNull()
    expect(hideDepth(null, '/repo')).toBeNull()
  })
})

describe('showDepth', () => {
  it('covers the entry subtree and nothing above the anchor', () => {
    const shown = classifyShows([
      { path: '/repo/public', mode: null },
      { path: '/repo/docs/*', mode: MountMode.READ },
    ])
    expect(showDepth(shown, '/repo/public/index.html')).toBe(2)
    expect(showDepth(shown, '/repo/public')).toBe(2)
    expect(showDepth(shown, '/repo/docs/a/b')).toBe(2)
    expect(showDepth(shown, '/repo')).toBeNull()
    expect(showDepth(null, '/repo/public')).toBeNull()
    // A stray slashless pattern from a typed constructor covers
    // nothing, failing toward refusal.
    expect(showDepth(classifyShows([{ path: '*.md', mode: null }]), '/a/x.md')).toBeNull()
  })
})

describe('showHead', () => {
  it('is the anchor', () => {
    expect(showHead('/repo/public')).toBe('/repo/public')
    expect(showHead('/repo/docs/*')).toBe('/repo/docs')
    expect(showHead('/repo/*/x')).toBe('/repo')
  })
})

describe('pathVisible', () => {
  const hidden = classifyPaths(['/repo'])
  const shown = classifyShows([{ path: '/repo/public', mode: MountMode.READ }])

  it('is the anchor-depth rule', () => {
    expect(pathVisible(hidden, shown, '/repo/public/index.html')).toBe(true)
    expect(pathVisible(hidden, shown, '/repo/public')).toBe(true)
    expect(pathVisible(hidden, shown, '/repo/secrets/key.pem')).toBe(false)
    expect(pathVisible(null, shown, '/anywhere')).toBe(true)
    expect(pathVisible(hidden, null, '/repo/x')).toBe(false)
  })

  it('lets hide win the equal-depth tie', () => {
    const tied = classifyPaths(['/repo/public'])
    expect(pathVisible(tied, shown, '/repo/public/x')).toBe(false)
  })

  it('re-closes a deeper hide inside a show', () => {
    const nested = classifyPaths(['/repo', '/repo/public/sealed'])
    expect(pathVisible(nested, shown, '/repo/public/a.txt')).toBe(true)
    expect(pathVisible(nested, shown, '/repo/public/sealed/k')).toBe(false)
  })

  it('outranks a name pattern only inside the anchor', () => {
    const pem = classifyPaths(['*.pem'])
    const open = classifyShows([{ path: '/repo/public', mode: null }])
    expect(pathVisible(pem, open, '/repo/public/tls.pem')).toBe(true)
    expect(pathVisible(pem, open, '/other/tls.pem')).toBe(false)
  })

  it('keeps ancestors of a show anchor visible', () => {
    const deep = classifyShows([{ path: '/repo/public/docs', mode: null }])
    for (const virtual of ['/', '/repo', '/repo/public']) {
      expect(pathVisible(hidden, deep, virtual)).toBe(true)
    }
    expect(pathVisible(hidden, deep, '/repo/other')).toBe(false)
  })

  it('opens no road through a hidden show anchor', () => {
    const reclosed = classifyPaths(['/repo', '/repo/public'])
    const open = classifyShows([{ path: '/repo/public', mode: null }])
    expect(pathVisible(reclosed, open, '/repo')).toBe(false)
    expect(pathVisible(reclosed, open, '/repo/public/x')).toBe(false)
  })
})

describe('shownMode', () => {
  it('is the deepest mode entry, list entries silent', () => {
    const shown = classifyShows([
      { path: '/repo', mode: MountMode.READ },
      { path: '/repo/build', mode: MountMode.WRITE },
      { path: '/repo/public', mode: null },
    ])
    expect(shownMode(shown, '/repo/src/a.py')).toEqual([1, MountMode.READ])
    expect(shownMode(shown, '/repo/build/out')).toEqual([2, MountMode.WRITE])
    expect(shownMode(shown, '/repo/public/x')).toEqual([1, MountMode.READ])
    expect(shownMode(shown, '/elsewhere')).toBeNull()
    expect(shownMode(null, '/repo')).toBeNull()
  })

  it('takes the weaker at equal depth', () => {
    const both = classifyShows([
      { path: '/repo', mode: MountMode.EXEC },
      { path: '/repo/*', mode: MountMode.READ },
    ])
    expect(shownMode(both, '/repo/x')).toEqual([1, MountMode.READ])
  })
})

describe('classifyShows', () => {
  it('is null when empty', () => {
    expect(classifyShows([])).toBeNull()
    expect(classifyShows([{ path: '/a', mode: null }])).not.toBeNull()
  })
})

describe('hidesIntersect', () => {
  it('is the per-operand gate', () => {
    const spec = classifyPaths(['/repo/.env'])
    expect(hidesIntersect(spec, '/repo')).toBe(true)
    expect(hidesIntersect(spec, '/')).toBe(true)
    expect(hidesIntersect(spec, '/repo/.env')).toBe(true)
    expect(hidesIntersect(spec, '/s3')).toBe(false)
    expect(hidesIntersect(spec, '/repo/open')).toBe(false)
    expect(hidesIntersect(classifyPaths(['*.pem']), '/s3')).toBe(true)
    const sealed = classifyPaths(['/repo/sealed/*'])
    expect(hidesIntersect(sealed, '/repo')).toBe(true)
    expect(hidesIntersect(sealed, '/repo/sealed/x')).toBe(true)
    expect(hidesIntersect(sealed, '/repo/open')).toBe(false)
    expect(hidesIntersect(null, '/')).toBe(false)
  })

  it("counts an operand below a pattern's head", () => {
    // The wildcard tail can match anywhere under the fixed head, so a
    // walk of any subtree below it may hold matches (`/repo/*/secret`
    // covers `/repo/public/secret`), even though the operand itself is
    // neither hidden nor an ancestor of the head.
    const spec = classifyPaths(['/repo/*/secret'])
    expect(hidesIntersect(spec, '/repo/public')).toBe(true)
    expect(hidesIntersect(spec, '/repo/public/deep')).toBe(true)
    expect(hidesIntersect(spec, '/repo')).toBe(true)
    expect(hidesIntersect(spec, '/other')).toBe(false)
  })
})

describe('a globbed show keeps its anchor traversable', () => {
  it('the anchor and the road above answer by the same compare', () => {
    // `hide /repo` + `show /repo/public/*`: the matches score the
    // anchor's depth, so the anchor directory and the road above it
    // stay visible instead of hiding around visible children.
    const hidden = classifyPaths(['/repo'])
    const shown = classifyShows([{ path: '/repo/public/*', mode: null }])
    expect(pathVisible(hidden, shown, '/repo/public/index.html')).toBe(true)
    expect(pathVisible(hidden, shown, '/repo/public')).toBe(true)
    expect(pathVisible(hidden, shown, '/repo')).toBe(true)
    expect(pathVisible(hidden, shown, '/repo/secrets')).toBe(false)
    // A hide at the anchor's own depth still wins the tie.
    const rehidden = classifyPaths(['/repo', '/repo/public'])
    expect(pathVisible(rehidden, shown, '/repo/public')).toBe(false)
    expect(pathVisible(rehidden, shown, '/repo/public/index.html')).toBe(false)
  })
})

describe('moveReveals', () => {
  it('an exact entry below the source reveals at its mapped path', () => {
    const spec = classifyPaths(['/m/data/secret'])
    expect(moveReveals(spec, null, '/m/data', '/m/moved')).toBe(true)
    expect(moveReveals(spec, null, '/m/other', '/m/moved')).toBe(false)
    // The entry itself is the source: the operand is hidden and the
    // per-path guard answered before this predicate is asked.
    expect(moveReveals(spec, null, '/m/data/secret/deep', '/m/x')).toBe(false)
    expect(moveReveals(null, null, '/m/data', '/m/moved')).toBe(false)
  })

  it('no reveal when the mapped path stays hidden', () => {
    const spec = classifyPaths(['/m/d/sec', '/m/moved/sec'])
    expect(moveReveals(spec, null, '/m/d', '/m/moved')).toBe(false)
    expect(moveReveals(spec, null, '/m/d', '/m/elsewhere')).toBe(true)
  })

  it('component patterns follow the name and never reveal', () => {
    expect(moveReveals(classifyPaths(['*.env']), null, '/m/d', '/m/moved')).toBe(false)
  })

  it('anchored patterns fail toward refusal', () => {
    expect(moveReveals(classifyPaths(['/m/d/sec/*']), null, '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(classifyPaths(['/m/d/*']), null, '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(classifyPaths(['/m/*/secret']), null, '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(classifyPaths(['/other/*/secret']), null, '/m/d', '/m/moved')).toBe(false)
  })

  it('a show below the mapped path counts as a reveal', () => {
    const hidden = classifyPaths(['/m/d/sec', '/m/moved'])
    const shown = classifyShows([{ path: '/m/moved/sec/open', mode: null }])
    expect(moveReveals(hidden, shown, '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(hidden, null, '/m/d', '/m/moved')).toBe(false)
  })
})
