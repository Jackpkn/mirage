import { PolicyError } from '../../policy/errors.ts'
import type { Runtime } from '../../runtime/base.ts'
import { EvalError } from '../../runtime/errors.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import { isEvaluator, type Evaluator } from '../../runtime/mixin.ts'
import type { ScriptSource } from '../../runtime/policy/types.ts'
import { buildRuntime } from '../../runtime/table.ts'
import type { EvalValue, RuntimeLanguage } from '../../runtime/types.ts'
import { parseSessionProfile, type SessionProfile } from './permissions.ts'

export const PROFILE_EVAL_TIMEOUT_SECONDS = 10.0

/**
 * The sandboxed engine each language's role scripts run on. A role is
 * operator configuration evaluated once before any agent exists, so it
 * is deliberately NOT resolved out of the workspace's runtime world:
 * that world is the ordered set that serves *agent* code, it is mutable
 * after construction, an entry drops out of it silently when an optional
 * dependency is missing, and a world configured for what the agent runs
 * would decide which engine writes the document that governs the agent.
 *
 * monty on BOTH hosts, deliberately not DEFAULT_PYTHON. The two hosts
 * disagree about the default python engine (pyodide here, monty in
 * Python) because `@pydantic/monty` cannot answer builtin `open()` calls
 * yet, and agent code reads files. A role script does no file I/O at
 * all: it is handed a context and returns a mapping. So the reason for
 * that split does not reach here, and naming one engine means one source
 * produces one document on either host rather than two engines that
 * could disagree about the same program. A role wanting pyodide names it.
 */
export const PROFILE_RUNTIMES: Readonly<Record<RuntimeLanguage, string>> = {
  python: 'monty',
  js: 'quickjs',
}

/** What a role's script is told about the workspace it writes for.
 *
 * Deliberately small, and deliberately not per session: the script runs
 * once for the role, so it is told what the role is and where the mounts
 * are, and nothing that varies between the sessions later created from
 * it. A rule that depends on *who* is asking is the caller's to make by
 * naming a different role.
 */
export function profileContext(name: string, mounts: readonly string[]): Record<string, EvalValue> {
  return { profile: name, mounts: [...mounts] }
}

/** The one refusal wording, so every failure arm reads alike. */
function refuse(name: string, detail: string): PolicyError {
  return new PolicyError(`profile '${name}' script ${detail}`)
}

/**
 * The engine a role's script runs on, built for the role.
 *
 * Named explicitly by `runtime` when the role says so, otherwise the
 * sandboxed engine for the script's language. Either way it is built
 * here rather than picked out of the workspace's world, so which engine
 * writes a permission document is a property of the document.
 */
export function profileEvaluator(
  name: string,
  script: ScriptSource,
  runtime: string | null,
): Runtime & Evaluator {
  const wanted = runtime ?? PROFILE_RUNTIMES[script.language]
  let built: Runtime
  try {
    built = buildRuntime(wanted)
  } catch (err) {
    // An engine reports a missing dependency as its own error, which
    // unwrapped leaves the operator reading that engine's words with
    // nothing tying them to the role that asked.
    const detail = err instanceof Error ? err.message : String(err)
    throw refuse(name, `names runtime '${wanted}': ${detail}`)
  }
  if (!isEvaluator(built)) {
    throw refuse(
      name,
      `names runtime '${wanted}', which runs programs but cannot evaluate one; ` +
        `use '${PROFILE_RUNTIMES[script.language]}'`,
    )
  }
  // `language` is declared by LanguageRuntime, not by Runtime, so an
  // engine that interprets no language at all cannot answer here and is
  // left to the evaluation arm rather than compared against nothing.
  if (built instanceof LanguageRuntime && built.language !== script.language) {
    throw refuse(
      name,
      `is ${script.language}, but names runtime '${wanted}', which speaks ${built.language}`,
    )
  }
  return built
}

/**
 * Run a role's script and validate the document it wrote.
 *
 * Every failure arm throws, and none of them falls back to an empty
 * document: a role that says nothing restricts nothing, so a script that
 * threw, timed out or answered with the wrong shape would silently
 * produce an unrestricted session, the opposite of what stating the role
 * asked for.
 */
export async function evaluateProfile(
  name: string,
  script: ScriptSource,
  context: Record<string, EvalValue>,
  evaluator: Evaluator,
): Promise<SessionProfile> {
  let value: EvalValue
  try {
    // One named global, `ctx`, not the context's keys spread as several:
    // the script's contract is `ctx['profile']`, and spreading would put
    // `profile` and `mounts` in scope here and nowhere on the other host.
    value = (await withTimeout(name, evaluator.eval(script.source, { inputs: { ctx: context } })))
      .value
  } catch (err) {
    if (err instanceof PolicyError) throw err
    if (err instanceof EvalError) {
      throw refuse(name, `${err.syntax ? 'syntax error' : 'failed'}: ${err.message}`)
    }
    throw refuse(name, `failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // No type named: python and TypeScript have different words for
    // the same value (list/object, str/string), so quoting one would
    // make the two hosts word one failure differently.
    throw refuse(name, 'must end in the permission document it writes')
  }
  let written: SessionProfile
  try {
    written = parseSessionProfile(value, `profile '${name}' script`)
  } catch (err) {
    throw refuse(name, `wrote a document that is not valid: ${(err as Error).message}`)
  }
  if (written.script != null) throw refuse(name, 'wrote another script; a script writes a document')
  return written
}

/** Reject the evaluation once the budget is spent, naming the role. */
async function withTimeout<T>(name: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(refuse(name, `timed out after ${String(PROFILE_EVAL_TIMEOUT_SECONDS)}s`))
    }, PROFILE_EVAL_TIMEOUT_SECONDS * 1000)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
