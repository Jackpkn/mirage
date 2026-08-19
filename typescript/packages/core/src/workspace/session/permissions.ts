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

import {
  DEFAULT_ASK_REASON,
  DEFAULT_DENY_REASON,
  type CommandRule,
  type CommandsSpec,
} from '../../policy/types.ts'
import type { HiddenPaths, HiddenVars } from '../../types.ts'
import { type MountMode, parseMountMode } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'

/**
 * `paths:` of one tier. `hide` entries use the document's one grammar:
 * an entry with `*`, `?` or `[` is a pattern, anything else an exact
 * path and its subtree (`utils/hidden.classifyPaths`). `show` arrives
 * with its enforcement.
 */
export interface PathsBlock {
  readonly hide: readonly string[]
}

/** `vars:` of a profile: names or globs over names the session reads as unset. */
export interface VarsBlock {
  readonly hide: readonly string[]
}

/**
 * `commands:` of the workspace and profile tiers. `allow` lists the
 * command patterns the tier installs; a name none of them starts with is
 * not a command for the session (127, absent from `type` / `which` /
 * `man`), a line no pattern covers is refused. Grammar-tier shell
 * builtins and the agent's own functions are not subjects. `ask` rules
 * are admitted only with a host approval; `deny` rules refuse with a
 * reason. A bare string in either is one command pattern with the
 * default reason. `allow` null or absent (unstated) installs everything.
 */
export interface CommandsBlock {
  readonly allow?: readonly string[] | null
  readonly ask?: readonly CommandRule[]
  readonly deny: readonly CommandRule[]
}

/**
 * `commands:` of a mount tier: `ask` and `deny` only. A mount rule
 * applies to a line that works inside the mount (its cwd or one of its
 * paths lies under the root); its `paths` are mount-relative. There is
 * no mount-tier `allow`: what a session can see is a property of the
 * session, and an operand cannot make a command "not found".
 */
export interface MountCommandsBlock {
  readonly ask?: readonly CommandRule[]
  readonly deny: readonly CommandRule[]
}

/** `mounts.<prefix>.permissions`: mount-owned, relative to the mount root, binding every session. */
export interface MountPermissions {
  readonly paths: PathsBlock
  readonly commands?: MountCommandsBlock
}

/** Top-level `permissions:`: workspace-wide, absolute paths, binding every session. */
export interface WorkspacePermissions {
  readonly commands: CommandsBlock
  readonly paths: PathsBlock
}

/**
 * One role's narrowing: the profile a session is created from, the
 * inline document that tightens it, and the shape of both.
 *
 * Configuration, not enforcement: the resolver compiles the fields
 * onto the session's own narrowing fields and the doors keep
 * enforcing. A profile is a template (`extends` is field inheritance:
 * a stated field replaces the parent's, an absent one is inherited);
 * safety comes from the layer intersection at evaluation, never from
 * inheritance. Deliberately not named a View, which per the view
 * convention is a door-scoped handle an agent holds, while a profile
 * is what the embedder uses to *define* one. Immutable by type, so two
 * agents with the same role share one object and neither can bend the
 * other's view. Every field is absent/null when the document leaves it
 * unsaid, which is what inheritance reads.
 *
 * `mounts` is a Map or Record of prefix to mode ceiling (a mode name or
 * `r` / `rw` / `rwx`), or an array of prefixes that keeps each mount at
 * its own configured mode; `parseProfileMounts` normalizes every
 * spelling and the resolver reads only the normalized form.
 */
export interface SessionProfile {
  readonly extends?: string | null
  readonly cwd?: string | null
  readonly env?: Readonly<Record<string, string>> | null
  readonly mounts?:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>
    | readonly string[]
    | null
  readonly paths?: PathsBlock | null
  readonly vars?: VarsBlock | null
  readonly commands?: CommandsBlock | null
}

/**
 * The session fields an effective profile compiles to. `commands` is
 * the profile's own command tier, evaluated after the bound tiers.
 */
export interface CompiledProfile {
  readonly mountModes: ReadonlyMap<string, MountMode> | null
  readonly hiddenPaths: HiddenPaths | null
  readonly hiddenVars: HiddenVars | null
  readonly env: Readonly<Record<string, string>> | null
  readonly cwd: string | null
  readonly commands: CommandsSpec | null
}

const RULE_FIELDS = ['reason', 'commands', 'paths'] as const
const PATHS_FIELDS = ['hide'] as const
const VARS_FIELDS = ['hide'] as const
const COMMANDS_FIELDS = ['allow', 'ask', 'deny'] as const
const MOUNT_COMMANDS_FIELDS = ['ask', 'deny'] as const
const MOUNT_PERMISSIONS_FIELDS = ['paths', 'commands'] as const
const WORKSPACE_PERMISSIONS_FIELDS = ['commands', 'paths'] as const
const PROFILE_FIELDS = ['extends', 'cwd', 'env', 'mounts', 'paths', 'vars', 'commands'] as const

// A document mapping, not merely "an object": a Set, a Date or any class
// instance has no own enumerable string keys, so Object.entries would read
// one as an empty mapping and a `mounts` Set would compile to a session
// granting nothing at all. Python refuses the same values loudly.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function rejectUnknownKeys(
  block: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(block)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where}: unknown field \`${key}\` (allowed: ${allowed.join(', ')})`)
    }
  }
}

function asObject(raw: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Error(`${where} must be a mapping`)
  return raw
}

/** A document list, refused before a scalar can be iterated (python's `_list`). */
function asList(raw: unknown, where: string, expected = 'a list'): readonly unknown[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error(`${where} must be ${expected}`)
  return raw as readonly unknown[]
}

// A command pattern must hold a token: a blank one is a prefix of every
// line, so a stray "" would allow, ask about or deny every command.
function stringList(raw: unknown, where: string, nonblank = false): readonly string[] {
  return asList(raw, where, 'a list of strings').map((entry, i) => {
    if (typeof entry !== 'string') throw new Error(`${where}[${String(i)}] must be a string`)
    if (nonblank && entry.trim() === '')
      throw new Error(`${where}[${String(i)}] must name a command`)
    return entry
  })
}

function normPrefix(prefix: string): string {
  return '/' + stripSlash(prefix)
}

/**
 * Coerce one `deny` or `ask` entry: bare string = one command pattern
 * with the arm's default reason.
 */
function parseRule(raw: unknown, where: string, defaultReason: string): CommandRule {
  if (typeof raw === 'string') {
    return { reason: defaultReason, commands: stringList([raw], `${where}.commands`, true) }
  }
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, RULE_FIELDS, where)
  const reason = obj.reason ?? defaultReason
  if (typeof reason !== 'string') throw new Error(`${where}.reason must be a string`)
  return {
    reason,
    commands: stringList(obj.commands, `${where}.commands`, true),
    paths: stringList(obj.paths, `${where}.paths`),
  }
}

function parseRules(raw: unknown, where: string, arm: 'ask' | 'deny'): readonly CommandRule[] {
  const fallback = arm === 'ask' ? DEFAULT_ASK_REASON : DEFAULT_DENY_REASON
  return asList(raw, `${where}.${arm}`, 'a list of rules').map((entry, i) =>
    parseRule(entry, `${where}.${arm}[${String(i)}]`, fallback),
  )
}

function parseAllow(raw: unknown, where: string): readonly string[] | null {
  if (raw === undefined || raw === null) return null
  return stringList(raw, `${where}.allow`, true)
}

export function parsePathsBlock(raw: unknown, where = 'paths'): PathsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, PATHS_FIELDS, where)
  return { hide: stringList(obj.hide, `${where}.hide`) }
}

export function parseVarsBlock(raw: unknown, where = 'vars'): VarsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, VARS_FIELDS, where)
  return { hide: stringList(obj.hide, `${where}.hide`) }
}

export function parseCommandsBlock(raw: unknown, where = 'commands'): CommandsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, COMMANDS_FIELDS, where)
  return {
    allow: parseAllow(obj.allow, where),
    ask: parseRules(obj.ask, where, 'ask'),
    deny: parseRules(obj.deny, where, 'deny'),
  }
}

/** Validate a mount tier's `commands:` block (`ask` and `deny` only). */
export function parseMountCommandsBlock(raw: unknown, where = 'commands'): MountCommandsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, MOUNT_COMMANDS_FIELDS, where)
  return { ask: parseRules(obj.ask, where, 'ask'), deny: parseRules(obj.deny, where, 'deny') }
}

/** Validate a `mounts.<prefix>.permissions` block. */
export function parseMountPermissions(raw: unknown, where = 'permissions'): MountPermissions {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, MOUNT_PERMISSIONS_FIELDS, where)
  return {
    paths: obj.paths === undefined ? { hide: [] } : parsePathsBlock(obj.paths, `${where}.paths`),
    commands:
      obj.commands === undefined
        ? { ask: [], deny: [] }
        : parseMountCommandsBlock(obj.commands, `${where}.commands`),
  }
}

/** Validate the top-level `permissions:` block. */
export function parseWorkspacePermissions(
  raw: unknown,
  where = 'permissions',
): WorkspacePermissions {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, WORKSPACE_PERMISSIONS_FIELDS, where)
  return {
    commands:
      obj.commands === undefined
        ? { allow: null, ask: [], deny: [] }
        : parseCommandsBlock(obj.commands, `${where}.commands`),
    paths: obj.paths === undefined ? { hide: [] } : parsePathsBlock(obj.paths, `${where}.paths`),
  }
}

/**
 * Normalize the `mounts` spellings a profile or `createSession` accepts:
 * a Map or Record of prefix to mode (names or `r`/`rw`/`rwx`), a string,
 * or an array of prefixes.
 */
export function parseProfileMounts(
  raw: unknown,
  where = 'mounts',
): ReadonlyMap<string, MountMode> | readonly string[] | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') return [normPrefix(raw)]
  if (Array.isArray(raw)) return stringList(raw, where).map(normPrefix)
  let entries: [unknown, unknown][]
  if (raw instanceof Map) entries = [...raw.entries()]
  else if (isPlainObject(raw)) entries = Object.entries(raw)
  else throw new Error(`${where} must be a mapping or a list of strings`)
  const modes = new Map<string, MountMode>()
  for (const [prefix, mode] of entries) {
    if (typeof prefix !== 'string') throw new Error(`${where} keys must be strings`)
    if (typeof mode !== 'string')
      throw new Error(`${where}[${prefix}] must be a mode name or alias`)
    modes.set(normPrefix(prefix), parseMountMode(mode))
  }
  return modes
}

/** Validate one profile (a `profiles.<name>` block, or an inline document). */
export function parseSessionProfile(raw: unknown, where = 'profile'): SessionProfile {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, PROFILE_FIELDS, where)
  const out: {
    extends?: string | null
    cwd?: string | null
    env?: Readonly<Record<string, string>> | null
    mounts?: ReadonlyMap<string, string> | readonly string[] | null
    paths?: PathsBlock | null
    vars?: VarsBlock | null
    commands?: CommandsBlock | null
  } = {}
  if (obj.extends !== undefined && obj.extends !== null) {
    if (typeof obj.extends !== 'string') throw new Error(`${where}.extends must be a string`)
    out.extends = obj.extends
  }
  if (obj.cwd !== undefined && obj.cwd !== null) {
    if (typeof obj.cwd !== 'string') throw new Error(`${where}.cwd must be a string`)
    out.cwd = obj.cwd
  }
  if (obj.env !== undefined && obj.env !== null) {
    const env = asObject(obj.env, `${where}.env`)
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') throw new Error(`${where}.env.${k} must be a string`)
    }
    out.env = env as Record<string, string>
  }
  if (obj.mounts !== undefined && obj.mounts !== null) {
    out.mounts = parseProfileMounts(obj.mounts, `${where}.mounts`)
  }
  if (obj.paths !== undefined && obj.paths !== null)
    out.paths = parsePathsBlock(obj.paths, `${where}.paths`)
  if (obj.vars !== undefined && obj.vars !== null)
    out.vars = parseVarsBlock(obj.vars, `${where}.vars`)
  if (obj.commands !== undefined && obj.commands !== null)
    out.commands = parseCommandsBlock(obj.commands, `${where}.commands`)
  return out
}
