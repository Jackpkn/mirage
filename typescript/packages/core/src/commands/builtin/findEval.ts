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

import { fnmatch } from '../../utils/fnmatch.ts'
import type { LinkView } from '../../ops/types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { DIR_MODE, FILE_MODE } from '../../utils/stat_view.ts'
import { FileStat, FileType } from '../../types.ts'
import { lsModeString } from './utils/formatting.ts'

export interface FindEntry {
  key: string
  name: string
  // 'l' is a namespace symlink: GNU find without -L reports the link
  // itself and never walks through it, so it is never 'f' or 'd'.
  kind: 'f' | 'd' | 'l'
  depth: number
  isEmpty?: boolean | null
}

export type PredNode =
  | { op: 'name'; pattern: string; icase: boolean }
  // `-path` matches the display path as printed (mount prefix + key), so
  // the tree is stamped with the mount prefix before evaluation
  // (`prefixPathNodes`); entry keys stay mount-relative (#396).
  | { op: 'path'; pattern: string; prefix?: string }
  | { op: 'type'; kind: string }
  | { op: 'empty' }
  | { op: 'not'; kid: PredNode }
  | { op: 'and'; kids: PredNode[] }
  | { op: 'or'; kids: PredNode[] }
  | { op: 'true' }

export function evalPredicate(node: PredNode, entry: FindEntry): boolean {
  switch (node.op) {
    case 'true':
      return true
    case 'empty':
      return entry.isEmpty === true
    case 'name':
      return node.icase
        ? fnmatch(entry.name.toLowerCase(), node.pattern.toLowerCase())
        : fnmatch(entry.name, node.pattern)
    case 'path':
      return fnmatch(displayPath(node.prefix ?? '', entry.key), node.pattern)
    case 'type':
      return entry.kind === node.kind
    case 'not':
      return !evalPredicate(node.kid, entry)
    case 'and':
      return node.kids.every((kid) => evalPredicate(kid, entry))
    case 'or':
      return node.kids.some((kid) => evalPredicate(kid, entry))
  }
}

// Display path for a mount-relative key, as `find` prints it. Mirrors
// applyMountPrefix for a single key: the mount root maps to the bare
// prefix, everything else joins with one slash.
export function displayPath(prefix: string, key: string): string {
  if (!prefix) return key
  const rel = stripSlash(key)
  return rel === '' ? prefix : `${prefix}/${rel}`
}

// Copy of a predicate tree with `path` nodes bound to a prefix. `-path`
// matches the display path, but backend find ops evaluate entries by
// mount-relative key; stamping the prefix onto the tree keeps the
// evaluation site prefix-free (#396).
export function prefixPathNodes(node: PredNode, prefix: string): PredNode {
  if (!prefix) return node
  switch (node.op) {
    case 'path':
      return { op: 'path', pattern: node.pattern, prefix }
    case 'not':
      return { op: 'not', kid: prefixPathNodes(node.kid, prefix) }
    case 'and':
      return { op: 'and', kids: node.kids.map((kid) => prefixPathNodes(kid, prefix)) }
    case 'or':
      return { op: 'or', kids: node.kids.map((kid) => prefixPathNodes(kid, prefix)) }
    default:
      return node
  }
}

export function treeHasType(node: PredNode): boolean {
  if (node.op === 'type') return true
  if (node.op === 'not') return treeHasType(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasType)
  return false
}

export function treeHasEmpty(node: PredNode): boolean {
  if (node.op === 'empty') return true
  if (node.op === 'not') return treeHasEmpty(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasEmpty)
  return false
}

export function keep(
  entry: FindEntry,
  tree: PredNode,
  minDepth: number | null | undefined,
): boolean {
  if (minDepth !== null && minDepth !== undefined && entry.depth < minDepth) return false
  return evalPredicate(tree, entry)
}

// Basename of a find start path, as GNU prints and matches it. Single source
// of truth for the start path's own name across every backend find op; reads
// `path.virtual` so the name is correct whether the start is the mount root
// or a nested directory. Returns '' for the bare root '/'.
export function startBasename(virtual: string): string {
  return rstripSlash(virtual).split('/').pop() ?? ''
}

export interface EmitStartPathOptions {
  kind: 'f' | 'd'
  isEmpty?: boolean | null
  exists: boolean
  tree: PredNode
  maxDepth: number | null | undefined
  minDepth: number | null | undefined
  size?: number | null | undefined
  minSize?: number | null | undefined
  maxSize?: number | null | undefined
}

// Append the search start path to results when it matches. Shared by every
// backend find op so the start path is emitted uniformly: bare `find <dir>`,
// `-type d` on the root, `-maxdepth 0`, `-mindepth 0`, and `-name` against the
// start's own basename all behave the same everywhere. A directory start path
// contributes size 0 to `-size` filtering (mirage directories have no
// meaningful content size; a documented divergence from GNU, which compares
// the inode size), so `-size +N` excludes directory roots and `-size -N`
// keeps them (#318). A file start with an unknown size skips the filter.
export function emitStartPath(
  results: string[],
  startKey: string,
  startName: string,
  opts: EmitStartPathOptions,
): void {
  if (!opts.exists) return
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && opts.maxDepth < 0) return
  const entry: FindEntry = {
    key: startKey,
    name: startName,
    kind: opts.kind,
    depth: 0,
    isEmpty: opts.isEmpty ?? null,
  }
  if (!keep(entry, opts.tree, opts.minDepth)) return
  if (
    (opts.minSize !== null && opts.minSize !== undefined) ||
    (opts.maxSize !== null && opts.maxSize !== undefined)
  ) {
    // Directories count as size 0 for -size: GNU compares the inode size (e.g. 4096 on ext4); see CLAUDE.md Rules.
    const effective = opts.kind !== 'f' ? 0 : (opts.size ?? null)
    if (effective !== null) {
      if (opts.minSize !== null && opts.minSize !== undefined && effective < opts.minSize) return
      if (opts.maxSize !== null && opts.maxSize !== undefined && effective > opts.maxSize) return
    }
  }
  results.push(startKey)
}

export interface BuildTreeOptions {
  name?: string | null | undefined
  iname?: string | null | undefined
  pathPattern?: string | null | undefined
  type?: string | null | undefined
  nameExclude?: string | null | undefined
  orNames?: string[] | null | undefined
  empty?: boolean | null | undefined
}

// Whether a directory holds namespace symlinks directly under it.
//
// `-empty` asks whether a directory has entries, and a symlink is one of
// them. No backend readdir can see a namespace link, so every emptiness
// probe has to add this or a directory holding only a link reads as empty.
// Shared because find asks it in two places: the start point's row and
// each directory the walk reaches.
export function hasLinkChildren(links: LinkView | null | undefined, virtual: string): boolean {
  if (links === null || links === undefined) return false
  return links.children(rstripSlash(virtual) || '/').length > 0
}

export function buildTree(opts: BuildTreeOptions): PredNode {
  const kids: PredNode[] = []
  if (opts.orNames !== null && opts.orNames !== undefined && opts.orNames.length > 0) {
    kids.push({
      op: 'or',
      kids: opts.orNames.map((pat) => ({ op: 'name', pattern: pat, icase: false })),
    })
  } else if (opts.name !== null && opts.name !== undefined) {
    kids.push({ op: 'name', pattern: opts.name, icase: false })
  }
  if (opts.iname !== null && opts.iname !== undefined) {
    kids.push({ op: 'name', pattern: opts.iname, icase: true })
  }
  if (opts.pathPattern !== null && opts.pathPattern !== undefined) {
    kids.push({ op: 'path', pattern: opts.pathPattern })
  }
  if (opts.type !== null && opts.type !== undefined) {
    kids.push({ op: 'type', kind: opts.type })
  }
  if (opts.nameExclude !== null && opts.nameExclude !== undefined) {
    kids.push({ op: 'not', kid: { op: 'name', pattern: opts.nameExclude, icase: false } })
  }
  if (opts.empty === true) {
    kids.push({ op: 'empty' })
  }
  const [first, ...rest] = kids
  if (first === undefined) return { op: 'true' }
  if (rest.length === 0) return first
  return { op: 'and', kids }
}

// The predicate tree for a FindOptions bag: the pre-built expression tree
// when present, otherwise the flag-form fields. Single source of truth for
// the fallback every backend find op used to hand-roll.
export function optionsTree(options: {
  name?: string | null
  iname?: string | null
  pathPattern?: string | null
  type?: string | null
  nameExclude?: string | null
  orNames?: string[] | null
  empty?: boolean | null
  tree?: PredNode | null
}): PredNode {
  return (
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
      empty: options.empty,
    })
  )
}

export function computeNonemptyDirs(keys: string[]): Set<string> {
  const nonempty = new Set<string>()
  for (const k of keys) {
    const cut = k.lastIndexOf('/')
    nonempty.add(cut > 0 ? k.slice(0, cut) : '/')
  }
  return nonempty
}

const PRINTF_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '\\': '\\',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
}
const STAT_DIRECTIVES = new Set(['s', 'y', 'Y', 'm', 'M', 'T'])
// One mode per kind, spelled from the same constants every stat
// translator uses (utils/stat_view.ts); links are 777 the way ls draws
// them. A reported mode (chmod overlay, a backend that knows) supplies
// the permission bits; the kind always fixes the type bits.
const KIND_MODE: Record<PrintfKind, number> = { d: DIR_MODE, l: 0o120777, f: FILE_MODE }
const KIND_TYPE: Record<PrintfKind, FileType> = {
  d: FileType.DIRECTORY,
  l: FileType.SYMLINK,
  f: FileType.TEXT,
}
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

// Whether a -printf format reads anything off the entry's stat.
export function printfNeedsStat(fmt: string): boolean {
  let i = 0
  while (i < fmt.length - 1) {
    const ch = fmt.charAt(i)
    if (ch === '%' && STAT_DIRECTIVES.has(fmt.charAt(i + 1))) return true
    if (ch === '%' || ch === '\\') {
      i += 2
      continue
    }
    i += 1
  }
  return false
}

// Map one respelled display row back to its virtual path: the inverse of
// respellRaw, for the stat probe.
export function unrespellRaw(row: string, virtual: string, raw: string): string {
  if (raw === '' || raw === virtual) return row
  if (row === raw) return virtual
  const stem = raw.endsWith('/') ? raw : raw + '/'
  if (row.startsWith(stem)) {
    const base = virtual.replace(/\/+$/, '')
    return base + '/' + row.slice(stem.length)
  }
  return row
}

function relativePart(row: string, base: string): string {
  if (row === base) return ''
  const stem = base.endsWith('/') ? base : base + '/'
  if (row.startsWith(stem)) return row.slice(stem.length)
  return row
}

function pad(n: number, width: number, fill = '0'): string {
  return String(n).padStart(width, fill)
}

function timeDirective(letter: string, ts: number): string | null {
  if (letter === '@') return ts.toFixed(10)
  const dt = new Date(ts * 1000)
  const frac = ts.toFixed(10).split('.')[1] ?? '0000000000'
  switch (letter) {
    case '+':
      return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}+${pad(dt.getUTCHours(), 2)}:${pad(dt.getUTCMinutes(), 2)}:${pad(dt.getUTCSeconds(), 2)}.${frac}`
    case 'Y':
      return pad(dt.getUTCFullYear(), 4)
    case 'y':
      return pad(dt.getUTCFullYear() % 100, 2)
    case 'm':
      return pad(dt.getUTCMonth() + 1, 2)
    case 'd':
      return pad(dt.getUTCDate(), 2)
    case 'e':
      return String(dt.getUTCDate()).padStart(2, ' ')
    case 'H':
      return pad(dt.getUTCHours(), 2)
    case 'M':
      return pad(dt.getUTCMinutes(), 2)
    case 'S':
      return pad(dt.getUTCSeconds(), 2)
    case 'j': {
      const start = Date.UTC(dt.getUTCFullYear(), 0, 0)
      return pad(Math.floor((dt.getTime() - start) / 86_400_000), 3)
    }
    case 'a':
      return DAY_ABBR[dt.getUTCDay()] ?? ''
    case 'b':
    case 'h':
      return MONTH_ABBR[dt.getUTCMonth()] ?? ''
    case 'p':
      return dt.getUTCHours() < 12 ? 'AM' : 'PM'
    default:
      return null
  }
}

export type PrintfKind = 'f' | 'd' | 'l'

export interface PrintfStatFacts {
  size: number
  kind: PrintfKind
  mtimeEpoch: number
  // The permission bits a backend or the namespace overlay reported,
  // null for the per-kind default.
  mode: number | null
  // What %Y classifies on a symlink row: the target's kind, 'N' when the
  // link dangles. Ignored for a non-link row, where %Y is %y.
  targetKind: PrintfKind | 'N' | null
}

export function printfKind(st: FileStat): PrintfKind {
  return st.type === FileType.DIRECTORY ? 'd' : st.type === FileType.SYMLINK ? 'l' : 'f'
}

function modeBits(st: PrintfStatFacts | null, kind: PrintfKind): number {
  const base = KIND_MODE[kind]
  const mode = st?.mode ?? null
  if (mode === null) return base
  return (base & ~0o7777) | (mode & 0o7777)
}

function warnUnrecognized(src: string, warnings: string[]): void {
  const kind = src.startsWith('\\') ? 'escape' : 'format directive'
  const line = `find: warning: unrecognized ${kind} '${src}'`
  if (!warnings.includes(line)) warnings.push(line)
}

// Expand one -printf format against one result row. Directives cover what
// GNU's find agents actually use: the path family (%p %P %f %h %d), the
// stat family (%s %y %Y %m %M), %T times, and the backslash escapes. An
// unrecognized directive or escape renders literally and adds GNU's
// warning line once, exit code untouched -- which is GNU's own behavior.
// Times render in UTC (mirage timestamps are zone-carrying ISO strings;
// GNU renders the local zone). %Y on a symlink row reports the target's
// kind, N when the link dangles; on any other row it is %y. Mirrors the
// Python expand_printf.
export function expandPrintf(
  fmt: string,
  row: string,
  startBase: string,
  st: PrintfStatFacts | null,
  warnings: string[],
): string {
  const out: string[] = []
  let i = 0
  const n = fmt.length
  const kind = st === null ? 'f' : st.kind
  while (i < n) {
    const ch = fmt.charAt(i)
    if (ch === '\\' && i + 1 < n) {
      const nxt = fmt.charAt(i + 1)
      const mapped = PRINTF_ESCAPES[nxt]
      if (mapped !== undefined) {
        out.push(mapped)
      } else {
        warnUnrecognized(`\\${nxt}`, warnings)
        out.push(fmt.slice(i, i + 2))
      }
      i += 2
      continue
    }
    if (ch !== '%' || i + 1 >= n) {
      out.push(ch)
      i += 1
      continue
    }
    const code = fmt.charAt(i + 1)
    i += 2
    if (code === '%') {
      out.push('%')
    } else if (code === 'p') {
      out.push(row)
    } else if (code === 'P') {
      out.push(relativePart(row, startBase))
    } else if (code === 'f') {
      const trimmed = row.replace(/\/+$/, '')
      out.push(trimmed === '' ? '/' : (trimmed.split('/').pop() ?? trimmed))
    } else if (code === 'h') {
      const trimmed = row.replace(/\/+$/, '')
      if (!trimmed.includes('/')) {
        out.push(trimmed === '' ? '/' : '.')
      } else {
        const head = trimmed.slice(0, trimmed.lastIndexOf('/'))
        out.push(head === '' ? '/' : head)
      }
    } else if (code === 'd') {
      const rel = relativePart(row, startBase)
      out.push(rel === '' ? '0' : String(rel.split('/').length))
    } else if (code === 's') {
      out.push(String(st === null ? 0 : st.size))
    } else if (code === 'y') {
      out.push(st === null ? 'U' : kind)
    } else if (code === 'Y') {
      if (st === null) {
        out.push('U')
      } else if (kind === 'l') {
        out.push(st.targetKind ?? 'N')
      } else {
        out.push(kind)
      }
    } else if (code === 'm') {
      out.push((modeBits(st, kind) & 0o7777).toString(8))
    } else if (code === 'M') {
      const bits = modeBits(st, kind)
      out.push(lsModeString(new FileStat({ name: '', type: KIND_TYPE[kind], mode: bits & 0o7777 })))
    } else if (code === 'T' && i < n) {
      const letter = fmt.charAt(i)
      i += 1
      const rendered = timeDirective(letter, st === null ? 0 : st.mtimeEpoch)
      if (rendered === null) {
        warnUnrecognized(`%T${letter}`, warnings)
        out.push(`%T${letter}`)
      } else {
        out.push(rendered)
      }
    } else {
      warnUnrecognized(`%${code}`, warnings)
      out.push(`%${code}`)
    }
  }
  return out.join('')
}
