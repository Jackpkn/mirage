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

import type { Session } from './session.ts'

// Returns $HOME from the session env, or null when unset/empty, matching
// GNU bash (no implicit home; `cd` errors, `~` and $HOME do not expand).
export function homeDir(session: Session): string | null {
  const home = session.env.HOME
  return home !== undefined && home !== '' ? home : null
}

// The cwd as last spelled, falling back to the physical one. bash keeps
// two names for the working directory: the physical one it resolves to,
// and the logical one you typed to get there. Only `pwd`/`pwd -L`, $PWD
// and `cd`'s own `..` read the logical name; everything that resolves an
// operand uses `session.cwd`.
export function logicalCwd(session: Session): string {
  return session.logicalCwd ?? session.cwd
}

// Points the session at `cwd` without recording a `cd`, for the callers
// that move a session from outside the shell: a snapshot restore, the
// session-store handoff, and the `workspace.cwd` setter. No typed
// spelling exists behind such a move, so the logical name is dropped
// rather than left describing wherever the session used to be, and
// $OLDPWD is untouched because no `cd` ran.
export function setCwd(session: Session, cwd: string): void {
  session.cwd = cwd
  session.logicalCwd = undefined
}

// Moves the session and records $OLDPWD as the *logical* cwd, which is
// what bash stores and therefore what `cd -` returns to. Passing no
// `logical` keeps the pair collapsed, which is what `-P` wants.
//
// bash never re-validates the logical name: deleting the symlink it was
// spelled through leaves `pwd` still printing it. Nothing here checks it.
export function changeDir(session: Session, newCwd: string, logical?: string): void {
  session.env.OLDPWD = logicalCwd(session)
  session.cwd = newCwd
  session.logicalCwd = logical !== undefined && logical !== newCwd ? logical : undefined
}
