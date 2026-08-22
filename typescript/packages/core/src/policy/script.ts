import { CommandTimeoutError } from '../commands/builtin/utils/limit.ts'
import type { Runtime } from '../runtime/base.ts'
import { EvalError } from '../runtime/errors.ts'
import type { Evaluator } from '../runtime/mixin.ts'
import type { ScriptSource } from '../runtime/policy/types.ts'
import { evalWithCtx, scriptEngine } from '../runtime/script.ts'
import type { EvalValue } from '../runtime/types.ts'
import { PolicyError } from './errors.ts'
import { parseSessionProfile, type SessionProfile } from './profile.ts'

export const SCRIPT_EVAL_TIMEOUT_SECONDS = 10.0

/**
 * What a profile's script is told about the workspace.
 *
 * Deliberately small, and deliberately not per session: the script runs
 * once for the profile, so it is told which profile it produces
 * permissions for and where the mounts are, and nothing that varies
 * between the sessions later created under it. A rule that depends on
 * *who* is asking is the caller's to make by naming a different
 * profile.
 */
export function scriptContext(name: string, mounts: readonly string[]): Record<string, EvalValue> {
  return { profile: name, mounts: [...mounts] }
}

/** The one refusal wording, so every failure arm reads alike. */
function refuse(name: string, detail: string): PolicyError {
  return new PolicyError(`profile '${name}' script ${detail}`)
}

/**
 * Run one profile's script and validate the permissions it produced.
 *
 * Every failure arm throws, and none of them falls back to empty
 * permissions: permissions that say nothing restrict nothing, so a
 * script that threw, timed out or answered with the wrong shape would
 * silently produce an unrestricted session, the opposite of what
 * stating the script asked for.
 */
export async function permissionsFromScript(
  name: string,
  script: ScriptSource,
  context: Record<string, EvalValue>,
  evaluator: Evaluator,
): Promise<SessionProfile> {
  let value: EvalValue
  try {
    value = await evalWithCtx(
      script.source,
      context,
      evaluator,
      SCRIPT_EVAL_TIMEOUT_SECONDS,
      `profile '${name}' script`,
    )
  } catch (err) {
    if (err instanceof CommandTimeoutError) {
      throw refuse(name, `timed out after ${String(SCRIPT_EVAL_TIMEOUT_SECONDS)}s`)
    }
    if (err instanceof EvalError) {
      throw refuse(name, `${err.syntax ? 'syntax error' : 'failed'}: ${err.message}`)
    }
    throw refuse(name, `failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // No type named: python and TypeScript have different words for
    // the same value (list/object, str/string), so quoting one would
    // make the two hosts word one failure differently.
    throw refuse(name, 'must end in the permissions it produces')
  }
  let produced: SessionProfile
  try {
    produced = parseSessionProfile(value, `profile '${name}' script`)
  } catch (err) {
    throw refuse(name, `produced permissions that are not valid: ${(err as Error).message}`)
  }
  if (produced.script != null) {
    throw refuse(name, 'produced another script; a script produces permissions')
  }
  return produced
}

/**
 * Run every profile's script, returning the permissions per name.
 *
 * All of them run before any result is returned, so one broken profile
 * refuses the whole set rather than leaving the profiles that happened
 * to be evaluated first done and the rest still scripts; without that,
 * whether a session could be created depended on where its profile sat
 * in the mapping. Permissions are operator configuration, so a
 * workspace that cannot realize what it was given does not serve;
 * every refusal names the profile.
 *
 * Engines are shared per kind rather than built per profile: each is a
 * worker, so building one for every scripted profile would spawn N of
 * them to run N short programs.
 */
export async function permissionsFromScripts(
  scripted: Readonly<Record<string, SessionProfile>>,
  mounts: readonly string[],
): Promise<Record<string, SessionProfile>> {
  const produced: Record<string, SessionProfile> = {}
  const engines = new Map<string, Runtime & Evaluator>()
  try {
    for (const [name, profile] of Object.entries(scripted)) {
      const script = profile.script
      if (typeof script === 'string') {
        throw new PolicyError(
          `profile '${name}' names a script by path ('${script}'); ` +
            `only the config door loads one, pass ScriptSource in code`,
        )
      }
      if (script == null) continue
      let engine: Runtime & Evaluator
      try {
        engine = scriptEngine(script, profile.runtime ?? null)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new PolicyError(`profile '${name}' ${detail}`)
      }
      const cached = engines.get(engine.name)
      if (cached === undefined) engines.set(engine.name, engine)
      else engine = cached
      produced[name] = await permissionsFromScript(
        name,
        script,
        scriptContext(name, mounts),
        engine,
      )
    }
  } finally {
    for (const engine of engines.values()) await engine.close()
  }
  return produced
}
