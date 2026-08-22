import { runWithTimeout } from '../commands/builtin/utils/limit.ts'
import type { Runtime } from './base.ts'
import { LanguageRuntime } from './language.ts'
import { isEvaluator, type Evaluator } from './mixin.ts'
import type { ScriptSource } from './policy/types.ts'
import { buildRuntime } from './table.ts'
import type { EvalValue, RuntimeLanguage } from './types.ts'

export const CTX_GLOBAL = 'ctx'

/**
 * The sandboxed default engine per config-script language. A config
 * script is operator configuration, so its engine is built fresh and
 * never picked out of a workspace's runtime world: the world is the
 * ordered set that serves *agent* code, it is mutable after
 * construction, and an entry drops out of it silently when an optional
 * dependency is missing.
 *
 * monty on BOTH hosts, deliberately not DEFAULT_PYTHON. The two hosts
 * disagree about the default python engine (pyodide here, monty in
 * Python) because `@pydantic/monty` cannot answer builtin `open()`
 * calls yet, and agent code reads files. A config script does no file
 * I/O at all: it is handed a context and returns a value. So the
 * reason for that split does not reach here, and naming one engine
 * means one source produces one answer on either host rather than two
 * engines that could disagree about the same program.
 */
export const DEFAULT_SCRIPT_ENGINES: Readonly<Record<RuntimeLanguage, string>> = {
  python: 'monty',
  js: 'quickjs',
}

/**
 * Build the engine a config script runs on.
 *
 * The engine the config named when it names one, else the sandboxed
 * default for the script's language. Throws a plain Error whose
 * message is a clause about "script", for the caller to prefix with
 * whose script it is.
 */
export function scriptEngine(
  script: ScriptSource,
  runtime: string | null = null,
): Runtime & Evaluator {
  const wanted = runtime ?? DEFAULT_SCRIPT_ENGINES[script.language]
  let built: Runtime
  try {
    built = buildRuntime(wanted)
  } catch (err) {
    // An engine reports a missing dependency as its own error, each
    // carrying its own install hint.
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`script names runtime '${wanted}': ${detail}`)
  }
  if (!isEvaluator(built)) {
    throw new Error(
      `script names runtime '${wanted}', which runs programs but cannot evaluate one; ` +
        `use '${DEFAULT_SCRIPT_ENGINES[script.language]}'`,
    )
  }
  // `language` is declared by LanguageRuntime, not by Runtime, so an
  // engine that interprets no language at all cannot answer here and
  // is left to the evaluation arm rather than compared against nothing.
  if (built instanceof LanguageRuntime && built.language !== script.language) {
    throw new Error(
      `script is ${script.language}, but names runtime '${wanted}', which speaks ${built.language}`,
    )
  }
  return built
}

/**
 * Evaluate a config-borne script and return its last expression.
 *
 * The one place the config-script calling convention is written down:
 * the payload arrives as a single global named `ctx`, and the script's
 * last expression is its answer. Every config script speaks it (the
 * runtime router's `policy:`, a runtime's entry script, a profile's
 * `script:`), and they used to spell it out one at a time, which is a
 * convention two callers can drift apart on: this host passed the
 * payload's keys as separate globals for exactly one release, so `ctx`
 * was undefined here and defined in Python.
 *
 * Deliberately throws rather than wording its failures. Each caller
 * refuses in its own voice and its own error type (the runtime router's
 * PolicyError is not the permissions layer's), so a shared wording here
 * would put one layer's words on the other layer's failure.
 *
 * @throws CommandTimeoutError - the script outran `timeoutSeconds`.
 * @throws EvalError - the script did not parse, or threw.
 */
export async function evalWithCtx(
  source: string,
  ctx: Record<string, EvalValue>,
  evaluator: Evaluator,
  timeoutSeconds: number,
  label: string,
): Promise<EvalValue> {
  const result = await runWithTimeout(
    evaluator.eval(source, { inputs: { [CTX_GLOBAL]: ctx } }),
    timeoutSeconds,
    label,
  )
  return result.value
}
