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

import type { HiddenPaths, HiddenVars } from '../types.ts'
import { fnmatch } from './fnmatch.ts'
import { stripSlash } from './slash.ts'

/**
 * The characters that make a document entry a pattern rather than an
 * exact name; the permissions document has one grammar for every path
 * list, and this is the whole classification rule.
 */
const GLOB_CHARS = new Set(['*', '?', '['])

/** Whether a document entry is a pattern (any of `*`, `?`, `[`). */
export function isGlob(entry: string): boolean {
  for (const ch of entry) if (GLOB_CHARS.has(ch)) return true
  return false
}

/**
 * How specific a path entry is: the number of literal components before
 * its first wildcard.
 *
 * The one measure the permissions document's path axis orders by.
 * `/repo/sealed/*` is 2, `/repo/*` and the plain subtree `/repo` are 1,
 * and a slashless name pattern like `*.key` is 0, since it anchors
 * nothing. Every pattern the document allows has an answer, so two
 * entries about one path are always comparable and nothing is ever
 * guessed.
 *
 * It lives here beside `isGlob` rather than in the policy layer because
 * both gates need it: admission scores the rule that covers an operand,
 * and the entry gate scores the rule that covers an entry reached
 * mid-walk.
 */
export function anchorDepth(entry: string): number {
  let depth = 0
  for (const part of entry.replace(/^\/+|\/+$/g, '').split('/')) {
    if (part === '' || isGlob(part)) break
    depth += 1
  }
  return depth
}

/**
 * Compile document path entries into the matcher's shape: glob =
 * pattern, plain = exact subtree, in the order written. The same split
 * serves `paths.hide` and a `CommandRule`'s `paths`, so both planes
 * match through `pathHidden`. Null when there is nothing to match,
 * which is what "unrestricted" reads as.
 */
export function classifyPaths(entries: readonly string[]): HiddenPaths | null {
  const paths = entries.filter((e) => !isGlob(e))
  const patterns = entries.filter((e) => isGlob(e))
  if (paths.length === 0 && patterns.length === 0) return null
  return { paths, patterns }
}

/**
 * Compile document variable entries into the matcher's shape: glob =
 * pattern over names, plain = exact name. Null when empty.
 */
export function classifyVars(entries: readonly string[]): HiddenVars | null {
  const names = entries.filter((e) => !isGlob(e))
  const patterns = entries.filter((e) => isGlob(e))
  if (names.length === 0 && patterns.length === 0) return null
  return { names, patterns }
}

function normAbs(path: string): string {
  const stripped = stripSlash(path)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * Whether the session's spec hides this virtual path.
 *
 * The two planes of the spec, in the order they cost: an exact entry
 * hides the path and its whole subtree (prefix containment, no
 * globbing); a component pattern (no `/`) hides any path carrying a
 * matching name segment, which covers the subtree below a matching
 * directory for free; an anchored pattern (contains `/`) is tested
 * against the path and each of its ancestors, so a directory the
 * pattern hides keeps its descendants hidden too. Patterns match with
 * the repo fnmatch dialect, `*` crossing slashes as GNU `find -path`
 * does.
 */
/**
 * The fixed directory above an anchored pattern's first glob segment,
 * normalized (`/x/locked/*` -> `/x/locked`).
 */
function patternHead(pattern: string): string {
  const fixed: string[] = []
  for (const seg of normAbs(pattern).split('/')) {
    if (isGlob(seg)) break
    fixed.push(seg)
  }
  return normAbs(fixed.join('/'))
}

/**
 * Whether a spec has anything at or under this virtual path.
 *
 * Asked for an op that acts on a whole subtree (a rename of a directory,
 * a recursive remove): `/x/locked/*` protects the children of
 * `/x/locked`, and moving or removing `/x/locked` or `/x` takes them
 * along, so the op on the directory or an ancestor counts as touching
 * the scope. Exact entries and the fixed head of an anchored pattern
 * are tested; a component pattern (no `/`) names no place, so only a
 * walk could tell and it is not counted here. With `ancestors` false
 * only the directory holding the scope counts, which is the question for
 * a destination: moving into `/x/locked` lands in the scope, moving into
 * `/x` does not.
 */
export function pathCovers(
  hidden: HiddenPaths | null | undefined,
  virtual: string,
  ancestors = true,
): boolean {
  if (hidden == null) return false
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return false
  const norm = normAbs(virtual)
  const heads = paths.map(normAbs)
  for (const p of patterns) if (p.includes('/')) heads.push(patternHead(p))
  if (heads.some((head) => head === norm)) return true
  return ancestors && heads.some((head) => norm === '/' || head.startsWith(norm + '/'))
}

export function pathHidden(hidden: HiddenPaths | null | undefined, virtual: string): boolean {
  if (hidden == null) return false
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return false
  const norm = normAbs(virtual)
  for (const entry of paths) {
    const p = normAbs(entry)
    if (norm === p || norm.startsWith(p + '/') || p === '/') return true
  }
  if (patterns.length === 0) return false
  const componentPats = patterns.filter((p) => !p.includes('/'))
  const anchoredPats = patterns.filter((p) => p.includes('/')).map(normAbs)
  const parts = norm.split('/').filter((seg) => seg !== '')
  if (componentPats.length > 0) {
    for (const seg of parts) {
      for (const pat of componentPats) {
        if (fnmatch(seg, pat)) return true
      }
    }
  }
  if (anchoredPats.length > 0) {
    let prefix = ''
    for (const seg of parts) {
      prefix = `${prefix}/${seg}`
      for (const pat of anchoredPats) {
        if (fnmatch(prefix, pat)) return true
      }
    }
  }
  return false
}

/** Whether the session's spec hides this variable name. */
export function varHidden(hidden: HiddenVars | null | undefined, name: string): boolean {
  if (hidden == null) return false
  if ((hidden.names ?? []).includes(name)) return true
  for (const pat of hidden.patterns ?? []) {
    if (fnmatch(name, pat)) return true
  }
  return false
}
