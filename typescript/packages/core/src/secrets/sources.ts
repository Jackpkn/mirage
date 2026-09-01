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

import type { z } from 'zod'

import {
  SecretRefSchema,
  SecretSourceSchema,
  type SecretEntries,
  type SecretRef,
} from './config.ts'
import { SecretsError } from './errors.ts'
import { fieldSummary } from './summary.ts'
import { fetchSecret, sourceFor } from './registry.ts'
import type { ResolvedSecret, ResolvedSource } from './types.ts'

/**
 * Whether one config value is a pointer rather than a literal.
 *
 * The same rule the block's own schema applies, restated for a value
 * that reached us already parsed: a mapping carrying `from` is a
 * pointer, everything else belongs to the source's own model.
 */
function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'from' in value
}

/**
 * Read one source-config value from its bootstrap source.
 *
 * Throws SecretsError naming the instance, the field and the source,
 * and nothing else, whether the fetch failed or the field is absent.
 * That is the boundary `fillEnv` draws and it is drawn for the same
 * reason: a dotenv miss renders the host path it looked for, and a
 * custom source shadowing `env` renders whatever it likes. The
 * source's own words ride the `cause` chain and are never logged: this
 * plane writes no log line at all, because a log is a copy nobody
 * redacted and a source is free to quote the value it was handed.
 */
export async function configValue(
  label: string,
  ref: SecretRef,
  fetched: Map<string, ResolvedSecret>,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<string> {
  const cacheKey = `${ref.from}\u0000${ref.ref}`
  const seen = fetched.get(cacheKey)
  if (seen !== undefined) return selectField(label, ref, seen, sources)
  let secret
  try {
    secret = await fetchSecret(ref.from, ref.ref, sources)
  } catch (caught) {
    throw new SecretsError(`${label}: cannot fetch from ${ref.from}`, { cause: caught })
  }
  fetched.set(cacheKey, secret)
  return selectField(label, ref, secret, sources)
}

function selectField(
  label: string,
  ref: SecretRef,
  secret: ResolvedSecret,
  sources?: Readonly<Record<string, ResolvedSource>>,
): string {
  // Own properties only, the check `fillEnv` already makes: a plain
  // object answers `fields['constructor']` with a prototype member,
  // and that would reach the source's config model as a value.
  const value = Object.hasOwn(secret.fields, ref.key) ? secret.fields[ref.key] : undefined
  if (value === undefined) {
    // A declared instance is named by the deployment, so the summary
    // is told the source behind it: `{prod: {source: env}}` must
    // redact like `env`, not like an unknown name.
    const declared =
      sources !== undefined && Object.hasOwn(sources, ref.from) ? sources[ref.from] : undefined
    const provider = declared?.source ?? ref.from
    throw new SecretsError(
      `${label}: wanted field '${ref.key}', ` +
        `the ${ref.from} secret has ${fieldSummary(secret.fields, provider)}`,
    )
  }
  return value
}

/**
 * Whether a value is a plain config mapping rather than an instance.
 *
 * Only an object literal or `Object.create(null)` counts. A class
 * instance is left alone: a config field may hold a live object (a
 * notion `authProvider`, a client someone constructed), and rebuilding
 * one from its own entries drops every prototype method and accessor
 * the resource then calls. Python needs no such check -- its walk asks
 * `isinstance(value, Mapping)`, which an instance already fails.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Whether a raw config value is a `{from, ref, key}` pointer.
 *
 * Strict: a plain mapping only counts when it parses as the pointer
 * grammar exactly, extra keys included, so an ordinary object-valued
 * config field that happens to carry a `from` is left alone.
 */
export function isConfigPointer(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (!Object.hasOwn(value, 'from')) return false
  return SecretRefSchema.safeParse(value).success
}

/**
 * Whether a raw mount or CLI config names a secret anywhere inside.
 *
 * Read before any source is built, because building one reads its own
 * bootstrap pointers and a dotenv file is I/O. A config holding no
 * pointer must leave that I/O deferred to the first line that fills a
 * managed variable, or a declared source whose file is momentarily
 * unreadable stops the workspace from being created at all.
 */
export function configHoldsPointer(config: Readonly<Record<string, unknown>>): boolean {
  return Object.values(config).some(holdsPointer)
}

function holdsPointer(value: unknown): boolean {
  if (isConfigPointer(value)) return true
  if (Array.isArray(value)) return value.some(holdsPointer)
  if (isPlainObject(value)) return Object.values(value).some(holdsPointer)
  return false
}

async function resolveValue(
  value: unknown,
  label: string,
  fetched: Map<string, ResolvedSecret>,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<unknown> {
  if (isConfigPointer(value)) {
    return configValue(label, SecretRefSchema.parse(value), fetched, sources)
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const [i, item] of value.entries()) {
      out.push(await resolveValue(item, `${label}[${String(i)}]`, fetched, sources))
    }
    return out
  }
  if (isPlainObject(value)) {
    // fromEntries, not keyed assignment: a config key named
    // `__proto__` would otherwise assign through the prototype setter
    // and never reach the resource's own schema.
    const pairs: [string, unknown][] = []
    for (const [key, child] of Object.entries(value)) {
      pairs.push([key, await resolveValue(child, `${label}.${key}`, fetched, sources)])
    }
    return Object.fromEntries(pairs)
  }
  return value
}

/**
 * A raw mount or CLI config with every pointer read from its source.
 *
 * The same `configValue` a source's own config goes through, over the
 * config of a thing that reaches one. Resolved **before** the config is
 * parsed, so a credential stays the plain `string` its client already
 * reads and no resource, accessor or backend learns this plane exists.
 *
 * One `fetched` cache spans the whole config, so two fields naming one
 * secret cost one call and cannot straddle a rotation.
 */
export async function resolveConfigSecrets(
  config: Record<string, unknown>,
  sources?: Readonly<Record<string, ResolvedSource>>,
  label = 'config',
): Promise<Record<string, unknown>> {
  const fetched = new Map<string, ResolvedSecret>()
  const pairs: [string, unknown][] = []
  for (const [key, value] of Object.entries(config)) {
    pairs.push([key, await resolveValue(value, `${label}.${key}`, fetched, sources)])
  }
  return Object.fromEntries(pairs)
}

// The field path and the error code, never the rendered message: a
// custom source's own refinement may spell the rejected input, and the
// values are where a fetched credential has just landed. An
// unrecognized key carries no path, so its own names stand in -- they
// are what the deployment wrote in the block, not anything fetched.
function issueDetail(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.')
  const where = path !== '' ? path : issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : ''
  return `${where}: ${issue.code}`
}

/**
 * Build every declared instance, reading its pointers.
 *
 * Runs once per workspace, before the first fetch, and reaches only
 * bootstrap sources -- the process env and dotenv files -- so a
 * declaration this cannot satisfy is a config error and rightly fails
 * every line, while a source that is merely unreachable still fails
 * only the names that want it.
 *
 * Takes the block parsed or raw, because the three callers hold
 * different things: the constructor parses eagerly so a bad
 * declaration fails there, the config door and a clone override hand
 * over what they were given.
 *
 * Throws SecretsError for an unknown source, a missing bootstrap
 * field, or config the source's own model refuses. A refusal is
 * reported by field and reason only; the values are never in the
 * message.
 */
export async function resolveSources(
  declared: Readonly<SecretEntries>,
): Promise<Record<string, ResolvedSource>> {
  const out: [string, ResolvedSource][] = []
  // One fetch per bootstrap secret for the whole resolution: two
  // fields of one config naming the same dotenv file must read one
  // generation of it, or a rotation between them pins a mismatched
  // pair for the workspace's life.
  const fetched = new Map<string, ResolvedSecret>()
  for (const [name, raw] of Object.entries(declared)) {
    const block = SecretSourceSchema.parse(raw)
    const { configModel, fetch } = sourceFor(block.source)
    // fromEntries, not keyed assignment: the block's schema now keeps
    // a `__proto__` config key, and this is where it would be lost on
    // the way to the source's own model.
    const pairs: [string, unknown][] = []
    for (const [field, value] of Object.entries(block.config)) {
      pairs.push([
        field,
        isSecretRef(value)
          ? await configValue(`secrets.${name}.config.${field}`, value, fetched)
          : value,
      ])
    }
    const values = Object.fromEntries(pairs)
    let parsed
    try {
      parsed = configModel.safeParse(values)
    } catch (caught) {
      // A refinement that THROWS never becomes an issue list, and
      // safeParse does not catch it. Its words are over a value just
      // fetched, so they stay on the `cause` chain like every other
      // source's.
      throw new SecretsError(`secrets.${name}: config refused`, { cause: caught })
    }
    if (!parsed.success) {
      // The issue CODE, never zod's rendered message: a custom
      // source's own refinement may spell the rejected input, and
      // `values` is where a fetched credential has just landed. The
      // field path and the code say what is wrong.
      const detail = parsed.error.issues.map(issueDetail).join('; ')
      throw new SecretsError(`secrets.${name}: ${detail}`)
    }
    out.push([name, { source: block.source, config: parsed.data, fetch }])
  }
  // Object.fromEntries, not a keyed object literal: an instance named
  // `__proto__` assigns through the prototype setter and leaves no own
  // entry for the lookup to find, where python's dict takes the name
  // like any other.
  return Object.fromEntries(out)
}
