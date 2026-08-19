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
import type { EntryGate } from '../types.ts'
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

/**
 * A session touched a mount outside its allowlist.
 *
 * Stamped EACCES + operand so it behaves like python's `PermissionError`
 * from the same guard, which is a member of `FS_ERRORS`: callers that
 * handle filesystem errors per-operand (the redirect write pass) render
 * `<target>: Permission denied` instead of letting the guard's own prose
 * escape as the whole message. Callers that want the prose still read
 * `.message`, and the explicit `instanceof` checks in `command.ts` and the
 * FUSE bridge run before any of that and are unaffected.
 */
export class MountNotAllowedError extends Error {
  readonly sessionId: string
  readonly mountPrefix: string
  readonly code = 'EACCES'
  readonly virtualPath: string
  constructor(sessionId: string, mountPrefix: string) {
    super(`session '${sessionId}' not allowed to access mount '${mountPrefix}'`)
    this.name = 'MountNotAllowedError'
    this.sessionId = sessionId
    this.mountPrefix = mountPrefix
    this.virtualPath = mountPrefix
  }
}

function normPrefix(mountPrefix: string): string {
  const stripped = stripSlash(mountPrefix)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * The current session's mode cap for this mount: EXEC (no narrowing) when no
 * session is bound or the session is unrestricted, undefined when the
 * session has mount modes but none for this mount.
 */
function sessionMode(mountPrefix: string): MountMode | undefined {
  const sess = getCurrentSession()
  if (sess?.mountModes == null) return MountMode.EXEC
  return sess.mountModes.get(normPrefix(mountPrefix))
}

/**
 * Whether the current session may touch this mount at all.
 *
 * The non-raising twin of `assertMountAllowed`, for enumeration:
 * structure merges and fan-outs filter names through it, so a scoped
 * session never learns that an ungranted mount exists. True when no
 * session is bound or the session is unrestricted.
 */
export function mountAllowed(mountPrefix: string): boolean {
  return sessionMode(mountPrefix) !== undefined
}

/**
 * Whether the current session hides any paths at all, its own or the
 * workspace-bound ones every session carries.
 *
 * For a summarizing fast path (du -s asks the backend for one total)
 * that must not be trusted when hidden leaves could be inside it.
 */
export function hiddenPathsActive(): boolean {
  const sess = getCurrentSession()
  return sess?.hiddenPaths != null || sess?.boundHidden != null
}

/**
 * Whether the current session's hidden-paths specs, its own and the
 * workspace-bound one, leave this path visible.
 *
 * The path twin of `mountAllowed`: enumeration surfaces filter names
 * through it and the doors answer ENOENT (EACCES for creates) when it
 * says no, so hiding reads as nonexistence, never as a denial that
 * leaks the name. True when no session is bound or the session hides
 * nothing.
 */
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
  if (sess.hiddenPaths != null && pathHidden(sess.hiddenPaths, virtual)) return false
  return !(sess.boundHidden != null && pathHidden(sess.boundHidden, virtual))
}

/**
 * Whether the current session's hidden-paths specs, its own and the
 * workspace-bound one, leave this path visible: enumeration surfaces
 * filter names through it and the doors answer ENOENT (EACCES for
 * creates) when it says no, so hiding reads as nonexistence, never as a
 * denial that leaks the name. True when no session is bound.
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

/**
 * Throw if the current session may not touch this mount. A user-defined
 * root mount is governed like any other: a session must be granted `/`
 * to touch it.
 */
export function assertMountAllowed(mountPrefix: string): void {
  if (sessionMode(mountPrefix) !== undefined) return
  const sess = getCurrentSession()
  throw new MountNotAllowedError(sess?.sessionId ?? '', normPrefix(mountPrefix))
}

/**
 * The mount mode after narrowing by the current session's cap. The
 * mount's own mode is the ceiling; the session's mode can only weaken
 * it. A mount absent from the modes map narrows to READ here; visibility denial is
 * `assertMountAllowed`'s job at the dispatch entry points.
 */
export function effectiveMountMode(mountPrefix: string, mountMode: MountMode): MountMode {
  const cap = sessionMode(mountPrefix)
  if (cap === undefined) return MountMode.READ
  return weakerMode(mountMode, cap)
}
