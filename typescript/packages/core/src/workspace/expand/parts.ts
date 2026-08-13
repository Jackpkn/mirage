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

import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import { hasGlob, hasUnescapedGlob } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { expandTemplate, makeInert, substitute, templateGlobbable } from './brace.ts'
import { classifyWord } from './classify/index.ts'
import {
  BRACE_LITERAL_TYPES,
  BRACE_WORD_TYPES,
  QUOTED_WORD_TYPES,
  SPLIT_TYPES,
} from './constants.ts'
import {
  expandConcatChildren,
  expandNode,
  foldedWhitespace,
  unescapeUnquoted,
  type ExecuteFn,
} from './node.ts'
import { expandArrayAt, isMultiwordAt } from './variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'

/**
 * One expanded word plus whether pathname expansion may fire on it.
 *
 * Bash applies pathname expansion only to glob characters that were
 * typed unquoted: `'/data/*.txt'`, `"/data/*.txt"` and `/data/\*.txt`
 * are all the literal name, while `/data/*.txt` and the value of an
 * unquoted `$p` are patterns. Expansion is where quoting is still
 * visible, so the flag is computed here and carried to classification,
 * which otherwise sees only the bare text.
 */
export interface ExpandedWord {
  readonly text: string
  readonly globbable: boolean
}

// Whether one word node may contribute live glob characters. A quoted
// node never does; a plain word is read from its raw source text so a
// backslash-quoted glob stays dead; anything else is an unquoted
// expansion, whose produced characters are live the way bash treats
// them.
function nodeGlobbable(node: TSNodeLike, text: string): boolean {
  if (QUOTED_WORD_TYPES.has(node.type)) return false
  if (node.type === NT.WORD) return hasUnescapedGlob(node.text)
  return hasGlob(text)
}

// Brace-expand a concatenation or brace_expression into words. Literal
// word tokens form the brace template; every other child (expansions,
// strings, substitutions) expands first and joins as an inert atom, so
// `{a,$v}` alternates on the expanded value while `{1..$n}` stays
// literal, matching bash's brace-before-parameter ordering. Deliberate
// divergence: bash rewrites `$v{a,b}` to `$va $vb` before parameter
// expansion; here the prefix keeps its own expansion (`prea preb`),
// which is the useful reading.
//
// Each produced word reports whether it may glob: template text is
// scanned before its escapes are stripped, and an atom counts only when
// its child was an unquoted expansion holding glob characters, so
// `{'*',x}` stays literal while `{$p,x}` keeps the value live.
async function expandBraceWord(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<ExpandedWord[] | null> {
  const pieces: string[] = []
  const values: string[] = []
  const liveAtoms = new Set<number>()
  for (const child of node.children) {
    if (child.isNamed !== true || BRACE_LITERAL_TYPES.has(child.type)) {
      pieces.push(child.text)
    } else {
      const value = await expandNode(child, session, executeFn, callStack)
      if (nodeGlobbable(child, value)) liveAtoms.add(values.length)
      values.push(value)
      pieces.push(makeInert(values.length - 1))
    }
  }
  const words = expandTemplate(pieces.join(''))
  if (words === null) return null
  const home = homeDir(session)
  return words.map((w) => ({
    text: substitute(expandTilde(unescapeUnquoted(w), home), values),
    globbable: templateGlobbable(w, liveAtoms),
  }))
}

function stringHasArrayAt(node: TSNodeLike): boolean {
  for (const c of node.children) {
    if (isMultiwordAt(c)) return true
  }
  return false
}

async function expandStringWithArray(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string[]> {
  const expandChild = (n: TSNodeLike) => expandNode(n, session, executeFn, callStack)
  const fragments: string[] = ['']
  let splatYielded = false
  for (const child of node.children) {
    if (child.type === NT.DQUOTE) continue
    if (isMultiwordAt(child)) {
      const words = await expandArrayAt(child, session, callStack, expandChild)
      // The separating whitespace is folded into this node, and survives
      // even when the array is empty: bash renders "$x ${empty[@]}" as
      // the single word "a ".
      const gap = fragments.length - 1
      fragments[gap] = (fragments[gap] ?? '') + foldedWhitespace(child)
      if (words.length === 0) continue
      splatYielded = true
      const last = fragments.length - 1
      if (words.length === 1) {
        fragments[last] = (fragments[last] ?? '') + (words[0] ?? '')
      } else {
        fragments[last] = (fragments[last] ?? '') + (words[0] ?? '')
        for (let i = 1; i < words.length - 1; i++) fragments.push(words[i] ?? '')
        fragments.push(words[words.length - 1] ?? '')
      }
      continue
    }
    const text = await expandNode(child, session, executeFn, callStack)
    const last = fragments.length - 1
    fragments[last] = (fragments[last] ?? '') + text
  }
  // A splat that yielded nothing, with no text around it, is no word at
  // all. One empty ELEMENT is a word though (set -- "" passes one empty
  // argument), so the rendered text cannot decide this; only the element
  // count can. An empty expansion beside it does not rescue the word
  // either: with no parameters, "$u$@" is nothing.
  if (!splatYielded && fragments.length === 1 && fragments[0] === '') return []
  return fragments
}

/**
 * Expand tree-sitter child nodes to words that know their quoting.
 *
 * The texts are exactly expandParts'; each word additionally reports
 * whether pathname expansion may fire on it (see ExpandedWord). An
 * unquoted expansion's words are live the way bash treats them; a
 * quoted word never is; a concatenation is live when any child is, so
 * `"/data/"*.txt` globs while `'/data/*'.txt` stays literal.
 */
export async function expandWords(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<ExpandedWord[]> {
  const result: ExpandedWord[] = []
  for (const p of parts) {
    if (p.type === NT.STRING && stringHasArrayAt(p)) {
      const words = await expandStringWithArray(p, session, executeFn, callStack)
      result.push(...words.map((w) => ({ text: w, globbable: false })))
      continue
    }
    if (BRACE_WORD_TYPES.has(p.type)) {
      const braceWords = await expandBraceWord(p, session, executeFn, callStack)
      if (braceWords !== null) {
        // Empty unquoted words vanish, like bash: {,x} -> x.
        for (const w of braceWords) {
          if (w.text !== '') result.push(w)
        }
        continue
      }
    }
    if (p.type === NT.CONCATENATION) {
      const pairs = await expandConcatChildren(p, session, executeFn, callStack)
      const text = pairs.map(([, t]) => t).join('')
      if (text !== '') {
        result.push({
          text,
          globbable: pairs.some(([child, t]) => nodeGlobbable(child, t)),
        })
      }
      continue
    }
    const expanded = await expandNode(p, session, executeFn, callStack)
    if (p.type === NT.COMMAND_SUBSTITUTION) {
      for (const word of expanded.split(/\s+/)) {
        if (word !== '') result.push({ text: word, globbable: hasGlob(word) })
      }
      continue
    }
    if (SPLIT_TYPES.has(p.type)) {
      for (const word of expanded.split(/\s+/)) {
        if (word !== '') result.push({ text: word, globbable: hasGlob(word) })
      }
    } else if (p.type === NT.STRING) {
      // A quoted word stays a word even when it expands to "" (echo ""
      // or "$EMPTY"), except "$@"/"${a[@]}" which yield zero words.
      // A quoted word stays a word even when it expands to '' (echo ""
      // or "$EMPTY"). The splats that yield zero words instead ("$@",
      // "${a[@]}") never reach here; they took the branch above.
      result.push({ text: expanded, globbable: false })
    } else if (
      p.type === NT.RAW_STRING ||
      p.type === NT.ANSI_C_STRING ||
      p.type === NT.TRANSLATED_STRING
    ) {
      result.push({ text: expanded, globbable: false })
    } else if (expanded !== '') {
      result.push({ text: expanded, globbable: nodeGlobbable(p, expanded) })
    }
  }
  return result
}

export async function expandParts(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string[]> {
  const words = await expandWords(parts, session, executeFn, callStack)
  return words.map((w) => w.text)
}

export async function expandAndClassify(
  words: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  cwd: string,
  callStack: CallStack | null = null,
): Promise<(string | PathSpec)[]> {
  // A word whose glob characters were all quoted keeps its literal
  // spelling: `for f in '/data/*.txt'` iterates once over the name as
  // typed, like bash.
  const expanded = await expandWords(words, session, executeFn, callStack)
  return expanded.map((w) => {
    const item = classifyWord(w.text, registry, cwd)
    if (item instanceof PathSpec && item.pattern !== null && !w.globbable) {
      return new PathSpec({
        virtual: item.virtual,
        directory: item.directory,
        pattern: null,
        resolved: item.resolved,
        resourcePath: item.resourcePath,
        rawPath: item.rawPath,
      })
    }
    return item
  })
}
