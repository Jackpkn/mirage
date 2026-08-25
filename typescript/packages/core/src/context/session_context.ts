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

import { asyncContextIsolatesTasks, createAsyncContext } from '../utils/async_context.ts'
import type { SessionManager } from '../workspace/session/manager.ts'
import type { Session } from '../workspace/session/session.ts'
import { stripSlash } from '../utils/slash.ts'
import {
  anchorDepth,
  hidesIntersect,
  isGlob,
  pathVisible,
  showHead,
  shownMode,
} from '../utils/hidden.ts'
import { erofsReadOnly } from '../utils/errors.ts'
import type { Policies } from '../policy/policies.ts'
import type { EntryGate, PathSpec } from '../types.ts'
import { MOUNT_MODE_RANK, MountMode, weakerMode } from '../types.ts'

/**
 * The session bound to one async context, and whose it is: `owner` is
 * the session manager it belongs to, which is one per workspace.
 */
interface SessionBinding {
  session: Session
  owner: SessionManager | null
}

const sessionStorage = createAsyncContext<SessionBinding>()

/**
 * Bind `session` for the duration of `fn`.
 *
 * `owner` names the manager the session belongs to; omitting it keeps
 * the owner already bound, so a nested bind inside a line (a
 * background job's fork) stays attributed to the workspace running it.
 */
export function runWithSession<T>(
  session: Session,
  fn: () => Promise<T>,
  owner?: SessionManager,
): Promise<T> {
  const binding: SessionBinding = {
    session,
    owner: owner ?? sessionStorage.getStore()?.owner ?? null,
  }
  return Promise.resolve(sessionStorage.run(binding, fn))
}

export function getCurrentSession(): Session | null {
  return sessionStorage.getStore()?.session ?? null
}

/**
 * The bound session, but only when `owner` published it.
 *
 * A session carries one workspace's cwd, env and mount grants, so a
 * second workspace re-entered mid-line must resolve its own session
 * rather than adopt this one.
 */
export function getCurrentSessionFor(owner: SessionManager): Session | null {
  const binding = sessionStorage.getStore()
  if (binding?.owner !== owner) return null
  return binding.session
}

function normPrefix(mountPrefix: string): string {
  const stripped = stripSlash(mountPrefix)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * The current session's mode for this mount.
 *
 * `MountMode.EXEC` (no narrowing) when no session is bound, when the
 * profile names no mount, or when it names none for this one: a profile's
 * mount sections narrow what the mount already offers and never decide
 * whether it exists. A profile that must not reach a mount hides it, which
 * answers ENOENT rather than a permission error naming something the
 * profile cannot see.
 */
function sessionMode(mountPrefix: string): MountMode {
  const sess = getCurrentSession()
  if (sess?.mountModes == null) return MountMode.EXEC
  return sess.mountModes.get(normPrefix(mountPrefix)) ?? MountMode.EXEC
}

/**
 * Whether the current session hides any paths at all.
 *
 * For a summarizing fast path (du -s asks the backend for one total)
 * that must not be trusted when hidden leaves could be inside it. Show
 * entries do not trip it: a show without a covering hide restricts
 * nothing, and modes never change what a walk enumerates.
 */
export function hiddenPathsActive(): boolean {
  return getCurrentSession()?.hiddenPaths != null
}

/**
 * Whether the current session hides anything at or under this path:
 * the per-operand form of `hiddenPathsActive`.
 *
 * The native fast paths (find's native op, du's summarize total)
 * classify the raw backend tree, so they fork to the guarded walk when
 * a hide could cover an entry inside the subtree they answer for, and
 * stay on when none can: one hidden `.env` under `/repo` must not
 * force `find` on `/s3` off its native op.
 */
export function hiddenPathsIntersect(virtual: string): boolean {
  const sess = getCurrentSession()
  return sess != null && hidesIntersect(sess.hiddenPaths, virtual)
}

export const DEFAULT_UMASK = 0o022

/**
 * The file-creation mask of the session bound to this context, read by
 * the creators that run inside a command handler (`mkdir`, which cannot
 * be handed the session) the way `pathAllowed` reads the hidden-paths
 * spec. bash's default when no session is bound.
 */
export function sessionUmask(): number {
  return getCurrentSession()?.umask ?? DEFAULT_UMASK
}

/**
 * Whether the bound session's `shopt -s dotglob` is on. Read inside
 * pathname expansion, which runs in every backend's resolveGlob and so
 * cannot be handed the session: a name starting with `.` is matched
 * only by a pattern that also starts with `.`, unless dotglob relaxes
 * it. False when no session is bound (bash's default).
 */
export function dotglobActive(): boolean {
  return getCurrentSession()?.shopts.dotglob === true
}

/**
 * Whether a session's path axis leaves this path visible: its hides,
 * re-opened where a deeper show entry says so. The explicit-session
 * form of `pathAllowed`, for a door that holds the session rather than
 * running under it: the admission gate drops a hidden operand before
 * any policy reads it, so a rule or an ask never names a path the
 * session cannot see.
 */
export function sessionPathAllowed(sess: Session, virtual: string): boolean {
  return pathVisible(sess.hiddenPaths, sess.shownPaths, virtual)
}

/**
 * Whether the current session's hides leave this path visible:
 * enumeration surfaces filter names through it and the doors answer
 * ENOENT (EACCES for creates) when it says no, so hiding reads as
 * nonexistence, never as a denial that leaks the name. True when no
 * session is bound. This is how a profile keeps a session away from a
 * mount, since naming mounts only narrows their modes.
 */
export function pathAllowed(virtual: string): boolean {
  const sess = getCurrentSession()
  return sess == null || sessionPathAllowed(sess, virtual)
}

const admissionStorage = createAsyncContext<EntryGate>()

/**
 * Bind the admitted command's entry gate for the duration of `fn`: the
 * run of that one command.
 *
 * Bound by the dispatcher once the gate let the command through, so a
 * nested line (`xargs`, `find -exec`, `eval`) binds its own and the outer
 * command gets its gate back when it returns, and a pipeline stage in
 * its own async context never sees a sibling's.
 */
export function runWithAdmission<T>(gate: EntryGate, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(admissionStorage.run(gate, fn))
}

/**
 * The entry gate of the command running in this context, null when no
 * admitted command is bound (a command constructed outside the
 * dispatcher, or a line no gate judged).
 */
export function getAdmission(): EntryGate | null {
  return admissionStorage.getStore() ?? null
}

/**
 * Whether a path rule in force reads the running command's paths.
 *
 * The twin of `hiddenPathsActive` for the rule arms: a backend's native
 * find or du classifies the raw tree, so an entry a rule refuses would be
 * listed or summed past the gate; the readdir walk passes every entry
 * through it instead. False when no admitted command is bound.
 */
export function pathRulesActive(): boolean {
  return getAdmission()?.scoped ?? false
}

const opPoliciesStorage = createAsyncContext<Policies | null>()

/**
 * Bind the workspace's admission policies for the duration of `fn`:
 * the run of one command.
 *
 * Bound by command dispatch around routing, the same window the
 * admission gate binds in, so the command tier's policy guard can fire
 * `preOps` for the backend I/O a handler performs. Read at wrap or
 * call time by `withPolicyGuard`; unset outside a dispatched command
 * (a generic invoked directly in a test), where the guard is inert.
 */
export function runWithOpPolicies<T>(policies: Policies, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(opPoliciesStorage.run(policies, fn))
}

/**
 * Unbind the op policies for the duration of `fn`: a delegated
 * sub-command whose door the caller has already cleared.
 *
 * find's `-delete` admits each removal itself, in find's own refusal
 * voice, and then delegates the mutation to `rm`; without the
 * suspension the delegated slot would admit the same deletion a second
 * time, so a counting or budget policy would see one removal twice.
 */
export function runWithSuspendedOpPolicies<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(opPoliciesStorage.run(null, fn))
}

/** The policies bound to the running command, null outside one. */
export function getOpPolicies(): Policies | null {
  return opPoliciesStorage.getStore() ?? null
}

const mountGateStorage = createAsyncContext<readonly [string, MountMode]>()

// The fallback storage is one global slot, so overlapping commands on
// different mounts (a pipeline's stages, a background job) would read
// each other's gate mid-await; every live gate is kept instead, and
// `mountGateFor` selects among them by the path being judged.
const liveMountGates: (readonly [string, MountMode])[] = []

function releaseMountGate(gate: readonly [string, MountMode]): void {
  const at = liveMountGates.indexOf(gate)
  if (at >= 0) liveMountGates.splice(at, 1)
}

/**
 * Bind the executing mount's prefix and configured mode for the
 * duration of `fn`: the run of one command.
 *
 * Bound by `Mount.executeCmd` around the handler, so the mode guard on
 * the command tier's I/O can resolve `effectivePathMode` for every path
 * a handler mutates: the write-command gate admits a command when any
 * shown subtree grants writes, and this binding is how each individual
 * write is then held to its own region's mode.
 *
 * Where the async context isolates tasks the binding rides it. On the
 * fallback storage (a browser with no AsyncLocalStorage) the gate joins
 * the live list instead, because a permission read off a slot another
 * mount's command can overwrite mid-await would judge a path against
 * the wrong mount.
 */
export function runWithMountGate<T>(
  prefix: string,
  mode: MountMode,
  fn: () => Promise<T>,
): Promise<T> {
  if (asyncContextIsolatesTasks) {
    return Promise.resolve(mountGateStorage.run([prefix, mode], fn))
  }
  const gate: readonly [string, MountMode] = [prefix, mode]
  liveMountGates.push(gate)
  try {
    return Promise.resolve(fn()).finally(() => {
      releaseMountGate(gate)
    })
  } catch (err) {
    releaseMountGate(gate)
    throw err
  }
}

/**
 * The gate of the mount serving `virtual`: its [prefix, configured
 * mode], null outside a mount's command (a generic invoked directly in
 * a test, or the scratch tier).
 *
 * Where the async context isolates tasks the binding answers and the
 * path plays no part. On the fallback storage the reader selects among
 * every live gate by the path itself: the longest prefix covering it
 * wins, the way the mount table routes, and two live gates at one
 * prefix (two workspaces sharing a fallback runtime) answer with the
 * weaker mode, failing toward refusal. A path no live gate covers
 * answers null, which is the same inert reading an unbound context
 * gives: the serving mount's own gate is live for the whole run of its
 * handler, so only a path outside every executing mount can miss.
 */
export function mountGateFor(virtual: string): readonly [string, MountMode] | null {
  if (asyncContextIsolatesTasks) {
    return mountGateStorage.getStore() ?? null
  }
  const v = normPrefix(virtual)
  let bestLen = -1
  let bestPrefix: string | null = null
  let bestMode: MountMode | null = null
  for (const [rawPrefix, mode] of liveMountGates) {
    const prefix = normPrefix(rawPrefix)
    if (prefix !== '/' && v !== prefix && !v.startsWith(prefix + '/')) continue
    if (prefix.length > bestLen) {
      bestLen = prefix.length
      bestPrefix = prefix
      bestMode = mode
    } else if (prefix.length === bestLen && bestMode !== null) {
      bestMode = weakerMode(bestMode, mode)
    }
  }
  return bestPrefix === null || bestMode === null ? null : [bestPrefix, bestMode]
}

const redirectStorage = createAsyncContext<[object, readonly PathSpec[]]>()

/**
 * Bind a statement's expanded redirect targets to the command node they
 * belong to, for the duration of `fn` (that node's run).
 *
 * The redirect layer expands the targets before the command executes (a
 * `$()` in one runs exactly once there), so the admission gate deep in
 * command dispatch cannot re-derive them; it reads them here instead.
 * Keyed by the node object itself so a nested line expanded on the way
 * to the command (a `$()` operand, an `eval`) never inherits the outer
 * statement's targets.
 */
export function runWithRedirectPaths<T>(
  node: object,
  paths: readonly PathSpec[],
  fn: () => Promise<T>,
): Promise<T> {
  return Promise.resolve(redirectStorage.run([node, paths], fn))
}

/**
 * The redirect targets bound to this command node, empty for any other
 * node or when none are bound.
 */
export function redirectPathsFor(node: object): readonly PathSpec[] {
  const bound = redirectStorage.getStore()
  if (bound?.[0] !== node) return []
  return bound[1]
}

/**
 * Whether a path is a redirect target the command door already judged
 * for the statement writing it now.
 *
 * The op doors ask this, and unlike `redirectPathsFor` it takes no node,
 * because by the time the shell writes the file the node has returned
 * and a door sees only a path. The binding is what keeps that honest: it
 * exists only while one statement's targets are being written, and a
 * statement whose targets a rule refused never reaches the write at all.
 * So a bound target is one the line was admitted with, and re-deriving a
 * verdict for it from a door that knows neither the line nor the nod it
 * holds can only get it wrong.
 */
export function redirectTargetJudged(virtual: string): boolean {
  const bound = redirectStorage.getStore()
  return bound?.[1].some((p) => p.virtual === virtual) ?? false
}

/**
 * The mount mode after narrowing by the current session's profile. The
 * mount's own mode is the strongest one available; a profile's mode can
 * only weaken it (a READ mount stays read-only whatever the profile says).
 * A mount the profile does not name keeps its own mode.
 */
export function effectiveMountMode(mountPrefix: string, mountMode: MountMode): MountMode {
  return weakerMode(mountMode, sessionMode(mountPrefix))
}

/**
 * The mode in force at one path: the whole VFS axis on the one
 * anchor-depth rule.
 *
 * The mount's configured mode is narrowed by the deepest session
 * statement covering the path, where a statement is the profile's
 * per-mount mode (scored at the mount prefix's own depth) or a
 * mode-carrying show entry (scored at its anchor depth). Deeper wins,
 * so `mounts: {/repo: r}` with `show: {"/repo/build": rw}` reads the
 * repo and writes only the build tree; an equal-depth pair takes the
 * weaker, failing toward refusal. The configured mode stays the
 * strongest answer possible: the document never grants past it.
 */
export function effectivePathMode(
  virtual: string,
  mountPrefix: string,
  mountMode: MountMode,
): MountMode {
  const sess = getCurrentSession()
  if (sess == null) return mountMode
  const prefix = normPrefix(mountPrefix)
  const cap = sess.mountModes?.get(prefix) ?? null
  let bestDepth = cap != null ? anchorDepth(prefix) : null
  let bestMode: MountMode | null = cap
  const deepest = shownMode(sess.shownPaths, virtual)
  if (deepest != null) {
    const [depth, mode] = deepest
    if (bestDepth === null || depth > bestDepth) {
      bestDepth = depth
      bestMode = mode
    } else if (depth === bestDepth && bestMode != null) {
      bestMode = weakerMode(bestMode, mode)
    }
  }
  if (bestMode == null) return mountMode
  return weakerMode(mountMode, bestMode)
}

/**
 * Whether a show anchor could cover any path under a mount prefix: the
 * anchor lies at or under the prefix, or the prefix inside the
 * anchor's subtree.
 */
function reachesUnder(head: string, prefix: string): boolean {
  return (
    head === '/' ||
    prefix === '/' ||
    head === prefix ||
    head.startsWith(prefix + '/') ||
    prefix.startsWith(head + '/')
  )
}

/**
 * The strongest mode the current session reaches anywhere under a
 * mount: its mount-wide effective mode, or a deeper show grant, still
 * capped by the mount's configured mode.
 *
 * What the whole-mount gates read: a write command stays runnable on a
 * mount whose only writable region is a show entry (the op door then
 * refuses per path), and the interpreters' any-`x` rule counts a show
 * grant the way it counts a whole mount.
 */
export function strongestModeUnder(mountPrefix: string, mountMode: MountMode): MountMode {
  let best = effectiveMountMode(mountPrefix, mountMode)
  const sess = getCurrentSession()
  if (sess?.shownPaths == null) return best
  const prefix = normPrefix(mountPrefix)
  for (const entry of sess.shownPaths.entries) {
    if (entry.mode == null) continue
    if (reachesUnder(showHead(entry.path), prefix)) {
      const reached = weakerMode(mountMode, entry.mode)
      if (MOUNT_MODE_RANK[reached] > MOUNT_MODE_RANK[best]) best = reached
    }
  }
  return best
}

/**
 * The path to blame when a subtree mutation reaches into a read-only
 * region below its operand, null when nothing below is weaker.
 *
 * The dual of the per-path check, for the ops that mutate a whole
 * subtree in one backend call (`rm -r`, a directory rename, a native
 * `cp -r`): the operand's own region may grant writes while a
 * mode-carrying show entry holds a deeper subtree to `r`, and the
 * backend cannot honor that boundary mid-call, so the caller refuses
 * the operand up front. An exact entry is blamed by its anchor, the
 * row GNU would report the refusal on; a pattern names no single
 * anchor, so the operand itself is blamed whenever the pattern's
 * match space could reach below it, failing toward refusal.
 */
export function readonlyBelow(
  virtual: string,
  mountPrefix: string,
  mountMode: MountMode,
): string | null {
  const sess = getCurrentSession()
  if (sess?.shownPaths == null) return null
  const v = '/' + virtual.replace(/^\/+|\/+$/g, '')
  for (const entry of sess.shownPaths.entries) {
    if (entry.mode == null) continue
    if (isGlob(entry.path)) {
      if (entry.mode === MountMode.READ && reachesUnder(showHead(entry.path), v)) {
        return virtual
      }
      continue
    }
    const anchor = '/' + entry.path.replace(/^\/+|\/+$/g, '')
    const below = v === '/' ? anchor !== '/' : anchor.startsWith(v + '/')
    if (!below) continue
    if (effectivePathMode(anchor, mountPrefix, mountMode) === MountMode.READ) {
      return anchor
    }
  }
  return null
}

/**
 * Refuse a service-addressed write unless the whole mount's effective
 * mode grants writes.
 *
 * For bespoke commands whose write is addressed by a service id rather
 * than a path (trello's card writes): the admission gate lets them run
 * while any shown subtree grants writes, but an id names no path a
 * per-path check could judge, so only the mount-wide grant counts and
 * a write-granting carve-out alone refuses, failing toward refusal.
 * Inert outside a mount's command. `mountPrefix` is the asking
 * command's own (`opts.mountPrefix`), which is what lets the fallback
 * storage select the right gate; the isolating runtimes answer from
 * the binding alone.
 */
export function requireMountWritable(mountPrefix: string): void {
  const gate = mountGateFor(mountPrefix)
  if (gate === null) return
  const [prefix, mode] = gate
  if (effectiveMountMode(prefix, mode) === MountMode.READ) {
    throw erofsReadOnly(`mount ${prefix} is read-only`, prefix)
  }
}
