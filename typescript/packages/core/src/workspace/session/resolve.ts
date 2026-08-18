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

import { PolicyError } from '../../policy/errors.ts'
import type { HiddenPaths } from '../../types.ts'
import { MountMode, weakerMode } from '../../types.ts'
import { classifyPaths, classifyVars } from '../../utils/hidden.ts'
import { stripSlash } from '../../utils/slash.ts'
import {
  parseProfileMounts,
  type CompiledProfile,
  type MountPermissions,
  type PathsBlock,
  type SessionProfile,
  type VarsBlock,
  type WorkspacePermissions,
} from './profile.ts'

export const DEFAULT_PROFILE = 'default'

/** A profile's mounts once every spelling is normalized: ceilings, an allowlist, or unrestricted. */
export type ProfileMounts = ReadonlyMap<string, MountMode> | readonly string[] | null

/**
 * Resolve a named profile through its `extends` chain.
 *
 * Field inheritance, root first: a stated field replaces the parent's,
 * an absent one is inherited. Safety comes from the layer intersection
 * at evaluation, not from inheritance, so a child may state fewer hides
 * than its parent. The result names no parent. Throws PolicyError on an
 * unknown name or a cycle.
 */
export function inherit(
  profiles: Readonly<Record<string, SessionProfile>>,
  name: string,
): SessionProfile {
  const chain: SessionProfile[] = []
  const seen: string[] = []
  let current: string | null | undefined = name
  while (current !== null && current !== undefined) {
    if (seen.includes(current)) {
      throw new PolicyError(`profile extends cycle: ${[...seen, current].join(' -> ')}`)
    }
    const node: SessionProfile | undefined = Object.prototype.hasOwnProperty.call(profiles, current)
      ? profiles[current]
      : undefined
    if (node === undefined) {
      const parent = seen.at(-1)
      const where =
        parent !== undefined ? `profile '${parent}' extends unknown profile` : 'unknown profile'
      throw new PolicyError(`${where} '${current}'`)
    }
    seen.push(current)
    chain.push(node)
    current = node.extends
  }
  const merged: {
    cwd?: string | null
    env?: Readonly<Record<string, string>> | null
    mounts?:
      | ReadonlyMap<string, string>
      | Readonly<Record<string, string>>
      | readonly string[]
      | null
    paths?: PathsBlock | null
    vars?: VarsBlock | null
  } = {}
  for (const node of [...chain].reverse()) {
    if (node.cwd != null) merged.cwd = node.cwd
    if (node.env != null) merged.env = node.env
    if (node.mounts != null) merged.mounts = node.mounts
    if (node.paths != null) merged.paths = node.paths
    if (node.vars != null) merged.vars = node.vars
  }
  return merged
}

/**
 * The profile a session is created from, before inline tightening: a
 * name resolves through `inherit`; a profile object that names a
 * parent resolves the same way with itself as the child; null picks
 * `profiles.default` when the workspace defines one and leaves the
 * session unrestricted otherwise.
 */
export function resolveProfile(
  profiles: Readonly<Record<string, SessionProfile>>,
  profile: string | SessionProfile | null | undefined,
): SessionProfile | null {
  if (profile === null || profile === undefined) {
    return Object.prototype.hasOwnProperty.call(profiles, DEFAULT_PROFILE)
      ? inherit(profiles, DEFAULT_PROFILE)
      : null
  }
  if (typeof profile === 'string') return inherit(profiles, profile)
  if (profile.extends == null) return profile
  return inherit({ ...profiles, '': profile }, '')
}

/**
 * The mounts both sides grant, at the weaker mode. A Map is a set of
 * ceilings, an array an allowlist at each mount's own mode. Map x Map:
 * common prefixes at the weaker mode; Map x array: the Map's entries the
 * list also names; array x array: the common prefixes; null x anything:
 * the other.
 */
function isCeilings(mounts: ProfileMounts): mounts is ReadonlyMap<string, MountMode> {
  return mounts instanceof Map
}

function intersectMounts(base: ProfileMounts, inline: ProfileMounts): ProfileMounts {
  if (base === null) return inline
  if (inline === null) return base
  const baseCeilings = isCeilings(base) ? base : null
  const inlineCeilings = isCeilings(inline) ? inline : null
  const baseListed = isCeilings(base) ? null : base
  const inlineListed = isCeilings(inline) ? null : inline
  if (baseCeilings !== null && inlineCeilings !== null) {
    const out = new Map<string, MountMode>()
    for (const [p, m] of baseCeilings) {
      const other = inlineCeilings.get(p)
      if (other !== undefined) out.set(p, weakerMode(m, other))
    }
    return out
  }
  if (baseCeilings !== null && inlineListed !== null) {
    return new Map([...baseCeilings].filter(([p]) => inlineListed.includes(p)))
  }
  if (inlineCeilings !== null && baseListed !== null) {
    return new Map([...inlineCeilings].filter(([p]) => baseListed.includes(p)))
  }
  if (baseListed !== null && inlineListed !== null)
    return baseListed.filter((p) => inlineListed.includes(p))
  return null
}

/** Every entry of both blocks, first spelling wins, order kept. */
function unionHide(
  a: PathsBlock | VarsBlock | null | undefined,
  b: PathsBlock | VarsBlock | null | undefined,
): string[] {
  const out: string[] = []
  for (const block of [a, b]) {
    for (const entry of block?.hide ?? []) if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/**
 * Narrow a profile by an inline document (design 3.4): mounts
 * intersect, hides union, `cwd` and `env` are the inline document's
 * when it states them (session presets, not permissions). Either side
 * null returns the other unchanged.
 */
export function tighten(
  base: SessionProfile | null,
  inline: SessionProfile | null,
): SessionProfile | null {
  if (base === null) return inline
  if (inline === null) return base
  const out: {
    cwd?: string | null
    env?: Readonly<Record<string, string>> | null
    mounts?: ProfileMounts
    paths?: PathsBlock | null
    vars?: VarsBlock | null
  } = {}
  const cwd = inline.cwd ?? base.cwd
  if (cwd != null) out.cwd = cwd
  if (base.env != null || inline.env != null)
    out.env = { ...(base.env ?? {}), ...(inline.env ?? {}) }
  const mounts = intersectMounts(parseProfileMounts(base.mounts), parseProfileMounts(inline.mounts))
  if (mounts !== null) out.mounts = mounts
  if (base.paths != null || inline.paths != null)
    out.paths = { hide: unionHide(base.paths, inline.paths) }
  if (base.vars != null || inline.vars != null)
    out.vars = { hide: unionHide(base.vars, inline.vars) }
  return out
}

/**
 * A mount's hides in absolute terms. Every entry, glob or plain, is
 * joined under the mount root, so a mount-relative rule can never reach
 * outside its mount; a slashless glob stops being a component pattern
 * and becomes anchored under the mount, which is the only reading
 * "relative to the mount root" can have.
 */
export function rebase(prefix: string, perms: MountPermissions | null | undefined): string[] {
  if (perms == null) return []
  const root = '/' + stripSlash(prefix)
  const base = root === '/' ? '' : root
  return perms.paths.hide.map((entry) => {
    const rel = entry.replace(/^\/+/, '')
    return rel === '' ? root : `${base}/${rel}`
  })
}

/**
 * What every session of the workspace cannot see: the workspace tier's
 * hides plus each mount's rebased hides, compiled once and stamped onto
 * every session by the session manager, joined with the session's own
 * hides in the predicate.
 */
export function boundHidden(
  workspace: WorkspacePermissions | null | undefined,
  mounts: ReadonlyMap<string, MountPermissions | null | undefined>,
): HiddenPaths | null {
  const entries: string[] = []
  if (workspace != null) entries.push(...workspace.paths.hide)
  for (const [prefix, perms] of mounts) entries.push(...rebase(prefix, perms))
  return classifyPaths(entries)
}

/** The session fields an effective profile sets; null is an unrestricted session. */
export function compileProfile(effective: SessionProfile | null): CompiledProfile {
  if (effective === null) {
    return { mountModes: null, hiddenPaths: null, hiddenVars: null, env: null, cwd: null }
  }
  const mounts = parseProfileMounts(effective.mounts)
  let modes: ReadonlyMap<string, MountMode> | null = null
  if (isCeilings(mounts)) modes = mounts
  else if (mounts !== null)
    modes = new Map(mounts.map((p): [string, MountMode] => [p, MountMode.EXEC]))
  return {
    mountModes: modes,
    hiddenPaths: classifyPaths(effective.paths?.hide ?? []),
    hiddenVars: classifyVars(effective.vars?.hide ?? []),
    env: effective.env ?? null,
    cwd: effective.cwd ?? null,
  }
}
