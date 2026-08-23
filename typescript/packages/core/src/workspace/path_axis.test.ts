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

import { afterEach, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const CARVE_PROFILE = parseSessionProfile({
  mounts: { '/repo': 'r' },
  paths: { hide: ['/repo'], show: { '/repo/public': 'r' } },
})

const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function seeded(mode: MountMode = MountMode.WRITE): Promise<Workspace> {
  const parser = await getTestParser()
  const repo = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(repo)
  const ws = new Workspace(
    { '/repo': [repo, mode] as const },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  open.push(ws)
  const io = await ws.execute(
    'mkdir -p /repo/secrets /repo/public/docs && ' +
      "printf 'hello repo\\n' > /repo/README.md && " +
      "printf 'PRIVATE needle\\n' > /repo/secrets/key.pem && " +
      "printf '<h1>needle</h1>\\n' > /repo/public/index.html && " +
      "printf 'docs needle\\n' > /repo/public/docs/a.txt",
  )
  expect(io.exitCode).toBe(0)
  return ws
}

async function carved(): Promise<Workspace> {
  const ws = await seeded()
  ws.createSession('rev', { profile: CARVE_PROFILE })
  return ws
}

describe('the path axis end to end', () => {
  it('a deeper show reopens its subtree', async () => {
    const ws = await carved()
    const ok = await ws.execute('cat /repo/public/index.html', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toContain('needle')
    const denied = await ws.execute('cat /repo/secrets/key.pem', { sessionId: 'rev' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toBe('cat: /repo/secrets/key.pem: No such file or directory\n')
  })

  it('every enumeration surface agrees on the carve-out', async () => {
    // One tree probed through ls, globs, find, grep -r and du: the same
    // predicate answers all of them, and this battery is what holds the
    // surfaces together if one grows its own filter.
    const ws = await carved()
    const listed = await ws.execute('ls /repo', { sessionId: 'rev' })
    expect(stdoutStr(listed).split(/\s+/).filter(Boolean)).toEqual(['public'])
    const globbed = await ws.execute('echo /repo/*', { sessionId: 'rev' })
    expect(stdoutStr(globbed)).toBe('/repo/public\n')
    const found = await ws.execute('find /repo', { sessionId: 'rev' })
    expect(stdoutStr(found)).toBe(
      '/repo\n/repo/public\n/repo/public/docs\n/repo/public/docs/a.txt\n/repo/public/index.html\n',
    )
    const grepped = await ws.execute('grep -rl needle /repo', { sessionId: 'rev' })
    expect(stdoutStr(grepped).split('\n').filter(Boolean).sort()).toEqual([
      '/repo/public/docs/a.txt',
      '/repo/public/index.html',
    ])
    const sized = await ws.execute('du -a /repo', { sessionId: 'rev' })
    const duPaths = stdoutStr(sized)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[1])
    expect(duPaths).not.toContain('/repo/secrets/key.pem')
    expect(duPaths).toContain('/repo/public/index.html')
  })

  it('the road to the carve-out exists', async () => {
    // `/repo` itself lies under the hide, but a visible show anchors
    // below it, so the directory stays traversable and lists only the
    // carve-out.
    const ws = await carved()
    const walked = await ws.execute('cd /repo && ls', { sessionId: 'rev' })
    expect(walked.exitCode).toBe(0)
    expect(stdoutStr(walked).split(/\s+/).filter(Boolean)).toEqual(['public'])
    const statOk = await ws.execute('test -d /repo/public && echo yes', { sessionId: 'rev' })
    expect(stdoutStr(statOk)).toBe('yes\n')
    const statGone = await ws.execute('test -e /repo/secrets || echo gone', { sessionId: 'rev' })
    expect(stdoutStr(statGone)).toBe('gone\n')
  })

  it('hide speaks before the mode', async () => {
    // Creating into hidden space answers EACCES (a silent success would
    // leave a file the session cannot see, and ENOENT would invite a
    // retry); the mode never speaks about a path the session cannot
    // see, so no refusal leaks that the region is read-only.
    const ws = await carved()
    const create = await ws.execute('echo x > /repo/secrets/new.txt', { sessionId: 'rev' })
    expect(stderrStr(create)).toBe('/repo/secrets/new.txt: Permission denied\n')
    const clobber = await ws.execute('echo x > /repo/secrets/key.pem', { sessionId: 'rev' })
    expect(stderrStr(clobber)).toBe('/repo/secrets/key.pem: Permission denied\n')
  })

  it('a write below the mode reads Read-only file system', async () => {
    const ws = await carved()
    const refused = await ws.execute('echo x > /repo/public/new.txt', { sessionId: 'rev' })
    expect(refused.exitCode).not.toBe(0)
    expect(stderrStr(refused)).toBe('/repo/public/new.txt: Read-only file system\n')
  })

  it('a deeper show mode refines the mount cap', async () => {
    // mounts: {/repo: r} + show {"/repo/build": rw}: the deeper entry
    // wins below its anchor, the mount cap holds everywhere else, and
    // the whole-mount write command gate lets the line reach the op
    // door instead of refusing the command outright.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { show: { '/repo/build': 'rw' } },
      }),
    })
    const ok = await ws.execute(
      'mkdir /repo/build && echo out > /repo/build/a.txt && cat /repo/build/a.txt',
      { sessionId: 'rev' },
    )
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toBe('out\n')
    const held = await ws.execute('echo x > /repo/README.md', { sessionId: 'rev' })
    expect(stderrStr(held)).toBe('/repo/README.md: Read-only file system\n')
  })

  it('a show mode never grants past the configured mode', async () => {
    // The mount's own mode stays the strongest answer possible: a show
    // stating rw on a READ-configured mount changes nothing.
    const parser = await getTestParser()
    const repo = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(repo)
    const ws = new Workspace(
      { '/repo': [repo, MountMode.READ] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { show: { '/repo/build': 'rw' } } }),
    })
    const refused = await ws.execute('echo x > /repo/build/a.txt', { sessionId: 'rev' })
    expect(refused.exitCode).not.toBe(0)
    expect(stderrStr(refused)).toBe('/repo/build/a.txt: Read-only file system\n')
  })

  it('a show without a covering hide restricts nothing', async () => {
    // 12.3b: show is a carve-out and a mode statement, never an
    // allowlist; a path outside every show entry stays visible.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { show: { '/repo/public': 'r' } } }),
    })
    const ok = await ws.execute('cat /repo/README.md', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toContain('hello')
  })

  it('scripts run only from an x region', async () => {
    // x per script path: the show grants rwx below one subtree, so a
    // script there runs and the same interpreter refuses one outside
    // it, in file-operand voice, exit 126.
    const ws = await seeded(MountMode.EXEC)
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { show: { '/repo/tools': 'rwx' } },
      }),
    })
    const seededTool = await ws.execute(
      `mkdir /repo/tools && echo 'print("ran")' > /repo/tools/go.py`,
      { sessionId: 'rev' },
    )
    expect(seededTool.exitCode).toBe(0)
    const ran = await ws.execute('python3 /repo/tools/go.py', { sessionId: 'rev' })
    expect(ran.exitCode).toBe(0)
    expect(stdoutStr(ran)).toBe('ran\n')
    const outside = await ws.execute('python3 /repo/public/index.html', { sessionId: 'rev' })
    expect(outside.exitCode).toBe(126)
    expect(stderrStr(outside)).toBe('python3: /repo/public/index.html: not in EXEC mode\n')
  }, 120_000)

  it('inline permissions cannot add show', async () => {
    const ws = await seeded()
    expect(() =>
      ws.createSession('rev', {
        profile: CARVE_PROFILE,
        permissions: parseSessionProfile({ paths: { show: ['/repo/secrets'] } }),
      }),
    ).toThrow('not show entries')
  })

  it('the write gate holds per path inside an admitted command', async () => {
    // The command gate admits mkdir because one region grants writes;
    // each write the handler then makes still answers for its own
    // region, so the whole-mount admission opens no side door.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { show: { '/repo/build': 'rw' } },
      }),
    })
    const ok = await ws.execute('mkdir /repo/build', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    const held = await ws.execute('mkdir /repo/probe', { sessionId: 'rev' })
    expect(held.exitCode).not.toBe(0)
    expect(stderrStr(held)).toContain('Read-only file system')
    const removed = await ws.execute('rm /repo/README.md', { sessionId: 'rev' })
    expect(removed.exitCode).not.toBe(0)
    expect(stderrStr(removed)).toContain('Read-only file system')
    const still = await ws.execute('cat /repo/README.md', { sessionId: 'rev' })
    expect(still.exitCode).toBe(0)
    // Copying OUT of the read-only region is a read plus a write into
    // the granted one, both allowed; moving back mutates a read-only
    // endpoint and is refused.
    const copied = await ws.execute('cp /repo/README.md /repo/build/copy.md', { sessionId: 'rev' })
    expect(copied.exitCode).toBe(0)
    const moved = await ws.execute('mv /repo/build/copy.md /repo/copy.md', { sessionId: 'rev' })
    expect(moved.exitCode).not.toBe(0)
    expect(stderrStr(moved)).toContain('Read-only file system')
  })

  it('a subtree mutation answers for the regions below it', async () => {
    // A native rm -r or a directory rename covers everything below its
    // operand in one backend call, so a read-only carve-out below the
    // operand refuses the whole op up front rather than being deleted
    // past the per-path check.
    const ws = await seeded()
    const grown = await ws.execute(
      'mkdir -p /repo/tree/locked && ' +
        "printf 'kept\\n' > /repo/tree/locked/f.txt && " +
        "printf 'open\\n' > /repo/tree/open.txt",
    )
    expect(grown.exitCode).toBe(0)
    ws.createSession('rev', {
      profile: parseSessionProfile({
        paths: { show: { '/repo/tree/locked': 'r' } },
      }),
    })
    const held = await ws.execute('rm -r /repo/tree', { sessionId: 'rev' })
    expect(held.exitCode).not.toBe(0)
    expect(stderrStr(held)).toBe("rm: cannot remove '/repo/tree/locked': Read-only file system\n")
    expect((await ws.execute('cat /repo/tree/locked/f.txt', { sessionId: 'rev' })).exitCode).toBe(0)
    expect((await ws.execute('cat /repo/tree/open.txt', { sessionId: 'rev' })).exitCode).toBe(0)
    const moved = await ws.execute('mv /repo/tree /repo/moved', { sessionId: 'rev' })
    expect(moved.exitCode).not.toBe(0)
    expect(stderrStr(moved)).toContain('Read-only file system')
    expect((await ws.execute('cat /repo/tree/locked/f.txt', { sessionId: 'rev' })).exitCode).toBe(0)
    // A subtree with no carve-out below still mutates freely.
    const ok = await ws.execute('rm -r /repo/public', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
  })

  it('a globbed show reopens and stays walkable', async () => {
    // The carve-out spelled as a pattern: the anchor directory the glob
    // exposes children of stays traversable, so the road to the matches
    // exists.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { hide: ['/repo'], show: ['/repo/public/*'] },
      }),
    })
    const walked = await ws.execute('ls /repo', { sessionId: 'rev' })
    expect(stdoutStr(walked).split(/\s+/).filter(Boolean)).toEqual(['public'])
    const listed = await ws.execute('ls /repo/public', { sessionId: 'rev' })
    expect(listed.exitCode).toBe(0)
    const found = await ws.execute('find /repo -type f', { sessionId: 'rev' })
    const out = stdoutStr(found).split('\n').filter(Boolean)
    expect(out).toContain('/repo/public/index.html')
    expect(out).not.toContain('/repo/secrets/key.pem')
  })

  it('a fork carries the carve-out', async () => {
    // A subshell forks the session; the axis rides the inherited
    // fields, so the fork answers exactly like its parent.
    const ws = await carved()
    const forked = await ws.execute('(cat /repo/secrets/key.pem)', { sessionId: 'rev' })
    expect(forked.exitCode).not.toBe(0)
    expect(stderrStr(forked)).toContain('No such file or directory')
    const ok = await ws.execute('(cat /repo/public/index.html)', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
  })
})
