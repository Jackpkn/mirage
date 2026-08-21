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

import { createAsyncContext } from '../utils/async_context.ts'
import type { SessionManager } from '../workspace/session/manager.ts'
import type { Session } from '../workspace/session/session.ts'
import { stripSlash } from '../utils/slash.ts'
import { pathHidden } from '../utils/hidden.ts'
import type { EntryGate, PathSpec } from '../types.ts'
import { MountMode, weakerMode } from '../types.ts'

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
 * role names no mount, or when it names none for this one: a role's
 * mount sections narrow what the mount already offers and never decide
 * whether it exists. A role that must not reach a mount hides it, which
 * answers ENOENT rather than a permission error naming something the
 * role cannot see.
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
 * that must not be trusted when hidden leaves could be inside it.
 */
export function hiddenPathsActive(): boolean {
  return getCurrentSession()?.hiddenPaths != null
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
 * Whether a session's hidden-paths specs, its own and the workspace-bound
 * one, leave this path visible. The explicit-session form of
 * `pathAllowed`, for a door that holds the session rather than running
 * under it: the admission gate drops a hidden operand before any policy
 * reads it, so a rule or an ask never names a path the session cannot
 * see.
 */
export function sessionPathAllowed(sess: Session, virtual: string): boolean {
  return !(sess.hiddenPaths != null && pathHidden(sess.hiddenPaths, virtual))
}

/**
 * Whether the current session's hides leave this path visible:
 * enumeration surfaces filter names through it and the doors answer
 * ENOENT (EACCES for creates) when it says no, so hiding reads as
 * nonexistence, never as a denial that leaks the name. True when no
 * session is bound. This is how a role keeps a session away from a
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
 * The mount mode after narrowing by the current session's role. The
 * mount's own mode is the strongest one available; a role's mode can
 * only weaken it (a READ mount stays read-only whatever the role says).
 * A mount the role does not name keeps its own mode.
 */
export function effectiveMountMode(mountPrefix: string, mountMode: MountMode): MountMode {
  return weakerMode(mountMode, sessionMode(mountPrefix))
}
