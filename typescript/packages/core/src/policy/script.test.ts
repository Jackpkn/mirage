import { describe, expect, it } from 'vitest'

import { EVALUATOR, type Evaluator } from '../runtime/mixin.ts'
import { EvalError } from '../runtime/errors.ts'
import { ScriptSource } from '../runtime/policy/types.ts'
import type { EvalResult, EvalValue } from '../runtime/types.ts'
import { PolicyError } from './errors.ts'
import { parseSessionProfile } from './profile.ts'
import { permissionsFromScript, permissionsFromScripts, scriptContext } from './script.ts'

const DOC = { commands: { allow: ['ls', 'cat'] }, cwd: '/repo' }

class FakeEngine implements Evaluator {
  readonly [EVALUATOR] = true as const
  seen: Record<string, EvalValue> = {}
  code = ''

  constructor(
    private readonly value: EvalValue = null,
    private readonly error: Error | null = null,
  ) {}

  eval(
    code: string,
    opts?: { inputs?: Record<string, EvalValue>; session?: string },
  ): Promise<EvalResult> {
    this.code = code
    this.seen = { ...(opts?.inputs ?? {}) }
    if (this.error !== null) return Promise.reject(this.error)
    return Promise.resolve({
      value: this.value,
      stdout: new Uint8Array(),
      stderr: null,
      exitCode: 0,
      status: 'complete',
    })
  }
}

describe('scriptContext', () => {
  it('names the profile and the mounts', () => {
    expect(scriptContext('release', ['/repo/', '/scratch/'])).toEqual({
      profile: 'release',
      mounts: ['/repo/', '/scratch/'],
    })
  })

  it('carries nothing per session', () => {
    // The script runs once for the profile, so a per-session fact
    // reaching it would be a promise the one evaluation cannot keep.
    const ctx = scriptContext('release', [])
    expect('session_id' in ctx).toBe(false)
    expect('agent_id' in ctx).toBe(false)
  })
})

describe('permissionsFromScript', () => {
  it('validates the produced permissions', async () => {
    const produced = await permissionsFromScript(
      'release',
      new ScriptSource('...', 'js'),
      scriptContext('release', ['/repo/']),
      new FakeEngine(DOC),
    )
    expect(produced.cwd).toBe('/repo')
    expect(produced.commands?.allow).toEqual(['ls', 'cat'])
  })

  it('shows the script its context', async () => {
    const engine = new FakeEngine(DOC)
    const ctx = scriptContext('release', ['/repo/'])
    await permissionsFromScript('release', new ScriptSource('SOURCE', 'js'), ctx, engine)
    expect(engine.code).toBe('SOURCE')
    expect(engine.seen).toEqual({ ctx })
  })

  it('refuses a script that threw', async () => {
    const engine = new FakeEngine(null, new EvalError('boom'))
    await expect(
      permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
    ).rejects.toThrow(/script failed: boom/)
  })

  it('names a syntax error as one', async () => {
    const engine = new FakeEngine(null, new EvalError('bad token', { syntax: true }))
    await expect(
      permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
    ).rejects.toThrow(/script syntax error/)
  })

  it.each([[null], [[1, 2]], ['commands'], [7]])(
    'refuses %j instead of permissions',
    async (value) => {
      // Empty permissions restrict nothing, so a wrong shape must never
      // coerce to one; every arm here has to throw rather than fall back.
      const engine = new FakeEngine(value as EvalValue)
      await expect(
        permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
      ).rejects.toThrow(/must end in the permissions/)
    },
  )

  it('refuses permissions that are not valid', async () => {
    const engine = new FakeEngine({ commands: { allow: 'ls' } })
    await expect(
      permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
    ).rejects.toThrow(/not valid/)
  })

  it('refuses a script that produced a script', async () => {
    const engine = new FakeEngine({ script: 'roles/other.py' })
    await expect(
      permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
    ).rejects.toThrow(/produced another script/)
  })

  it('names the profile in every refusal', async () => {
    const engine = new FakeEngine([])
    await expect(
      permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
    ).rejects.toThrow(/profile 'release' script/)
  })

  it('throws the policy error type', async () => {
    const engine = new FakeEngine([])
    await expect(
      permissionsFromScript('release', new ScriptSource('...', 'js'), {}, engine),
    ).rejects.toBeInstanceOf(PolicyError)
  })
})

describe('permissionsFromScripts', () => {
  it('refuses a script still spelled as a path', async () => {
    const scripted = { release: parseSessionProfile({ script: 'roles/x.py' }) }
    await expect(permissionsFromScripts(scripted, [])).rejects.toThrow(/names a script by path/)
  })
})
