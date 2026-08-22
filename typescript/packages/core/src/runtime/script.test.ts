import { describe, expect, it } from 'vitest'
import { CommandTimeoutError } from '../commands/builtin/utils/limit.ts'
import { EvalError } from './errors.ts'
import { EVALUATOR, isEvaluator, type Evaluator } from './mixin.ts'
import { ScriptSource } from './policy/types.ts'
import { CTX_GLOBAL, DEFAULT_SCRIPT_ENGINES, evalWithCtx, scriptEngine } from './script.ts'
import type { EvalResult, EvalValue } from './types.ts'

class Recorder implements Evaluator {
  readonly [EVALUATOR] = true as const
  inputs: Record<string, EvalValue> = {}

  constructor(
    private readonly value: EvalValue = null,
    private readonly delayMs = 0,
    private readonly error: Error | null = null,
  ) {}

  async eval(
    _code: string,
    opts?: { inputs?: Record<string, EvalValue>; session?: string },
  ): Promise<EvalResult> {
    this.inputs = { ...(opts?.inputs ?? {}) }
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.error !== null) throw this.error
    return {
      value: this.value,
      stdout: new Uint8Array(),
      stderr: null,
      exitCode: 0,
      status: 'complete',
    }
  }
}

describe('evalWithCtx', () => {
  it('shows the payload as one global named ctx', async () => {
    // The convention every config script speaks. Spreading the payload's
    // keys instead put `profile` in scope on one host and nothing on the
    // other, which no test using a fake evaluator could see.
    const engine = new Recorder('ok')
    await evalWithCtx('...', { profile: 'release' }, engine, 1, 'test')
    expect(engine.inputs).toEqual({ ctx: { profile: 'release' } })
    expect(CTX_GLOBAL).toBe('ctx')
  })

  it("answers with the script's last expression", async () => {
    expect(await evalWithCtx('...', {}, new Recorder({ a: 1 }), 1, 'test')).toEqual({ a: 1 })
  })

  it('lets a timeout reach the caller unworded', async () => {
    // Each caller refuses in its own voice, so this throws the bare
    // timeout rather than either layer's wording.
    await expect(evalWithCtx('...', {}, new Recorder('ok', 200), 0.01, 'test')).rejects.toThrow(
      CommandTimeoutError,
    )
  })

  it('lets an eval failure reach the caller unworded', async () => {
    await expect(
      evalWithCtx('...', {}, new Recorder(null, 0, new EvalError('boom')), 1, 'test'),
    ).rejects.toThrow(EvalError)
  })
})

describe('scriptEngine', () => {
  it('names monty for python, not the host default', () => {
    // Deliberately not DEFAULT_PYTHON: the two hosts disagree about
    // that (pyodide here) for a reason that is about agent code reading
    // files, which a config script never does. Naming one engine keeps
    // one source producing one answer on either host.
    expect(DEFAULT_SCRIPT_ENGINES).toEqual({ python: 'monty', js: 'quickjs' })
  })

  it('defaults to the language engine', () => {
    const engine = scriptEngine(new ScriptSource('...', 'python'))
    expect(engine.name).toBe('monty')
    expect(isEvaluator(engine)).toBe(true)
  })

  it('takes the named runtime', () => {
    expect(scriptEngine(new ScriptSource('...', 'python'), 'monty').name).toBe('monty')
  })

  it('refuses a runtime that cannot evaluate', () => {
    expect(() => scriptEngine(new ScriptSource('...', 'js'), 'vfs')).toThrow(/cannot evaluate one/)
  })

  it('refuses an unknown runtime', () => {
    expect(() => scriptEngine(new ScriptSource('...', 'js'), 'nope')).toThrow(/unknown runtime/)
  })

  it('refuses a runtime of the wrong language', () => {
    expect(() => scriptEngine(new ScriptSource('...', 'python'), 'quickjs')).toThrow(
      /python, but names runtime/,
    )
  })
})
