import { describe, expect, it } from 'vitest'
import { RAMResource } from '../resource/ram/ram.ts'
import { ScriptSource } from '../runtime/policy/types.ts'
import { MountMode } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const GOOD = "({commands: {allow: ['ls', 'cat', 'echo']}, cwd: '/data'})"

async function build(profiles: Record<string, unknown>, runtimes?: string[], profile?: string) {
  const shellParser = await getTestParser()
  return new Workspace(
    { '/data/': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParser,
      profiles: profiles as never,
      ...(runtimes !== undefined ? { runtimes } : {}),
      ...(profile !== undefined ? { profile } : {}),
    },
  )
}

describe('profile scripts', () => {
  it('runs a python profile script on monty, the engine both hosts name', async () => {
    const src = "{'commands': {'allow': ['ls', 'echo']}, 'cwd': '/data'}"
    const ws = await build({ release: { script: new ScriptSource(src, 'python') } })
    await ws.ensureSessionsLoaded()
    ws.createSession('s', { profile: 'release' })
    expect((await ws.execute('echo hi', { sessionId: 's' })).exitCode).toBe(0)
    expect(ws.getSession('s').cwd).toBe('/data')
    await ws.close()
  }, 120000)

  it('runs a python profile script on pyodide when the profile names it', async () => {
    // pyodide is this host's default python engine for *agent* code but
    // not for profile scripts, so naming it is the only way it produces
    // one; that makes this the explicit-`runtime:` path against a real
    // engine.
    const src = "{'commands': {'allow': ['ls', 'echo']}, 'cwd': '/data'}"
    const ws = await build({
      release: { script: new ScriptSource(src, 'python'), runtime: 'pyodide' },
    })
    await ws.ensureSessionsLoaded()
    ws.createSession('s', { profile: 'release' })
    expect((await ws.execute('echo hi', { sessionId: 's' })).exitCode).toBe(0)
    expect(ws.getSession('s').cwd).toBe('/data')
    await ws.close()
  }, 180000)

  it('shows the script one ctx global, not its keys spread', async () => {
    // The python host wraps the context as `ctx`; spreading it here
    // would put `profile` in scope on one host and nowhere on the other,
    // which no fake evaluator can catch.
    // The allow list is derived from ctx, so an unbound ctx throws at
    // hydration and a spread one allows 'nope' instead of 'echo'.
    const src = "({commands: {allow: ['ls', ctx.profile === 'release' ? 'echo' : 'nope']}})"
    const ws = await build({ release: { script: new ScriptSource(src, 'js') } })
    await ws.ensureSessionsLoaded()
    ws.createSession('s', { profile: 'release' })
    expect((await ws.execute('echo bound', { sessionId: 's' })).exitCode).toBe(0)
    await ws.close()
  })

  it('produces the permissions and enforces them', async () => {
    const ws = await build({ release: { script: new ScriptSource(GOOD, 'js') } })
    await ws.ensureSessionsLoaded()
    ws.createSession('s', { profile: 'release' })
    expect((await ws.execute('echo hi', { sessionId: 's' })).exitCode).toBe(0)
    expect((await ws.execute('rm /data/x', { sessionId: 's' })).exitCode).toBe(127)
    expect(ws.getSession('s').cwd).toBe('/data')
    await ws.close()
  })

  it('refuses createSession before hydration', async () => {
    const ws = await build({ release: { script: new ScriptSource(GOOD, 'js') } })
    expect(() => ws.createSession('s', { profile: 'release' })).toThrow(/ensureSessionsLoaded/)
    await ws.close()
  })

  it.each([
    ['throws', "(() => { throw new Error('boom') })()", /script failed/],
    ['returns a non-document', '([1, 2, 3])', /must end in the permission/],
    ['writes an invalid document', "({commands: {allow: 'ls'}})", /not valid/],
  ])('refuses a script that %s', async (_label, src, pattern) => {
    const ws = await build({ release: { script: new ScriptSource(src, 'js') } })
    await expect(ws.ensureSessionsLoaded()).rejects.toThrow(pattern)
    await ws.close()
  })

  it.each([[['bad', 'good']], [['good', 'bad']]])(
    'one broken profile refuses every scripted profile (%s)',
    async (order) => {
      const sources: Record<string, string> = {
        good: GOOD,
        bad: "(() => { throw new Error('boom') })()",
      }
      const profiles: Record<string, unknown> = {}
      for (const n of order) profiles[n] = { script: new ScriptSource(sources[n] ?? GOOD, 'js') }
      const ws = await build(profiles)
      await expect(ws.ensureSessionsLoaded()).rejects.toThrow(/profile 'bad' script/)
      expect(() => ws.createSession('s', { profile: 'good' })).toThrow(/ensureSessionsLoaded/)
      await ws.close()
    },
  )

  it('runs in a world with no evaluator', async () => {
    const ws = await build({ release: { script: new ScriptSource(GOOD, 'js') } }, ['vfs'])
    await ws.ensureSessionsLoaded()
    ws.createSession('s', { profile: 'release' })
    expect((await ws.execute('echo hi', { sessionId: 's' })).exitCode).toBe(0)
    await ws.close()
  })

  it('refuses an engine that cannot evaluate', async () => {
    const ws = await build({ release: { script: new ScriptSource(GOOD, 'js'), runtime: 'vfs' } })
    await expect(ws.ensureSessionsLoaded()).rejects.toThrow(/cannot evaluate one/)
    await ws.close()
  })

  it('refuses a runtime of the wrong language', async () => {
    const ws = await build({
      release: { script: new ScriptSource(GOOD, 'js'), runtime: 'pyodide' },
    })
    await expect(ws.ensureSessionsLoaded()).rejects.toThrow(/but names runtime 'pyodide'/)
    await ws.close()
  })

  it('a scripted default profile shapes the default session', async () => {
    // The constructor compiles the default profile before its script
    // runs, which is the script-only placeholder; hydration recompiles
    // it, or the primary agent keeps running under empty permissions.
    const ws = await build(
      { release: { script: new ScriptSource(GOOD, 'js') } },
      undefined,
      'release',
    )
    await ws.ensureSessionsLoaded()
    expect((await ws.execute('echo hi')).exitCode).toBe(0)
    expect((await ws.execute('rm /data/x')).exitCode).toBe(127)
    await ws.close()
  })

  it('hydrating twice runs the script once', async () => {
    const ws = await build({ release: { script: new ScriptSource(GOOD, 'js') } })
    await ws.ensureSessionsLoaded()
    await ws.ensureSessionsLoaded()
    ws.createSession('s', { profile: 'release' })
    expect((await ws.execute('echo hi', { sessionId: 's' })).exitCode).toBe(0)
    await ws.close()
  })
})
