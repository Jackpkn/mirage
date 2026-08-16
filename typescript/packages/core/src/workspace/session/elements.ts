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

import type { SessionView } from '../../ops/types.ts'
import { PolicyDenied } from '../../policy/index.ts'
import { evaluateArith } from '../../shell/arith.ts'
import {
  arrayCount,
  arrayExtent,
  arrayGet,
  arrayHas,
  arrayWith,
  type ShellArray,
} from '../../shell/array.ts'
import { ArithError } from '../../shell/errors.ts'
import type { ElementOps } from '../../shell/types.ts'
import type { ShellValue } from '../../shell/variable.ts'
import type { Session } from './session.ts'
import {
  ensureVarVisible,
  envGet,
  seedVar,
  visibleArrays,
  visibleAssocs,
  visibleEnv,
} from './state.ts'

const ELEMENT_REF = /^([A-Za-z_]\w*)(?:\[([\s\S]+)\])?$/

/**
 * Remove one surrounding quote pair from an associative subscript.
 *
 * An arithmetic reference carries its subscript verbatim, so `m["x"]`
 * arrives with the quotes bash would have removed; one layer comes off
 * and anything else is the key itself.
 */
export function stripKeyQuotes(text: string): string {
  const first = text.charAt(0)
  if (
    text.length >= 2 &&
    first === text.charAt(text.length - 1) &&
    (first === '"' || first === "'")
  ) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Resolve an indexed subscript in arithmetic context.
 *
 * bash evaluates indexed subscripts as arithmetic (`a[i+1]`); an
 * unresolvable expression indexes element 0, mirroring bash's
 * unset-name-is-zero arithmetic rule.
 */
export function elementIndex(
  subscript: string,
  env: Readonly<Record<string, string>>,
  elements: ElementOps | null = null,
): number {
  const trimmed = subscript.trim()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  try {
    return Number(evaluateArith(subscript, env, 0, elements).value)
  } catch (error) {
    if (error instanceof ArithError) return 0
    throw error
  }
}

/**
 * The `ElementOps` implementation bound to one session.
 *
 * A class rather than closures because the resolver recurses: an
 * indexed subscript is arithmetic and may itself hold an element
 * reference, so `resolve` hands the evaluator the same pair of
 * callbacks it is one of.
 */
class SessionElements implements ElementOps {
  constructor(private readonly session: Session) {}

  resolve(name: string, subscript: string, env: Readonly<Record<string, string>>): string {
    if (visibleAssocs(this.session)[name] !== undefined) {
      return stripKeyQuotes(subscript)
    }
    let idx = elementIndex(subscript, env, sessionElements(this.session))
    if (idx < 0) {
      const arr = visibleArrays(this.session)[name]
      if (arr !== undefined) idx += arrayExtent(arr)
      else if (envGet(this.session, name) !== null) idx += 1
      if (idx < 0) throw new ArithError(`${name}[${subscript}]: bad array subscript`)
    }
    return String(idx)
  }

  read(name: string, key: string): string | null {
    const amap = visibleAssocs(this.session)[name]
    if (amap !== undefined) return amap[key] ?? null
    const arr = visibleArrays(this.session)[name]
    const idx = Number(key)
    if (arr === undefined) {
      const scalar = envGet(this.session, name)
      if (scalar === null) return null
      return idx === 0 ? scalar : null
    }
    return arrayHas(arr, idx) ? arrayGet(arr, idx) : null
  }
}

/** Element callbacks bound to one session, for `evaluateArith`. */
export function sessionElements(session: Session): ElementOps {
  return new SessionElements(session)
}

/**
 * Whether a `name` / `name[sub]` reference names a set value.
 *
 * What `test -v` asks. A bare name over an array checks element 0 (the
 * literal key `"0"` for an associative one), which is GNU's rule;
 * `name[@]` and `name[*]` ask whether any element is set. An
 * associative subscript is the key verbatim; an indexed one evaluates
 * as arithmetic.
 */
export function elementIsSet(session: Session, ref: string): boolean {
  const match = ELEMENT_REF.exec(ref)
  if (match?.[1] === undefined) return false
  const name = match[1]
  const sub = match[2]
  const amap = visibleAssocs(session)[name]
  const arr = visibleArrays(session)[name]
  if (sub === undefined) {
    if (amap !== undefined) return amap['0'] !== undefined
    if (arr !== undefined) return arrayHas(arr, 0)
    return envGet(session, name) !== null
  }
  if (sub === '@' || sub === '*') {
    if (amap !== undefined) return Object.keys(amap).length > 0
    if (arr !== undefined) return arrayCount(arr) > 0
    return envGet(session, name) !== null
  }
  if (amap !== undefined) return amap[sub] !== undefined
  const scalar = envGet(session, name)
  let held: ShellArray
  if (arr !== undefined) held = arr
  else if (scalar !== null) held = [scalar]
  else return false
  let idx = elementIndex(sub, visibleEnv(session), sessionElements(session))
  if (idx < 0) idx += arrayExtent(held)
  return arrayHas(held, idx)
}

/**
 * Assign one element (or a bare name resolved as element 0).
 *
 * The element mechanics are computed on a copy and the landing write
 * goes through the door as the whole variable the write produces, so a
 * refused write leaves nothing half-applied and a `preSession` rule
 * sees `m[k]=v` as a write to `m`. The subscript arrives already
 * expanded: an associative name takes it as the key verbatim, an
 * indexed one evaluates it as arithmetic. A null subscript is a bare
 * target, which bash resolves as element 0 of an array and a plain
 * scalar otherwise. Answers `"ok"`, `"denied"`, `"readonly"`, or
 * `"subscript"`; a preSession refusal from the door propagates so the
 * rule's own message reaches the caller.
 */
export async function assignElement(
  session: Session,
  view: SessionView | null,
  name: string,
  subscript: string | null,
  value: string,
  append = false,
): Promise<'ok' | 'denied' | 'readonly' | 'subscript'> {
  try {
    ensureVarVisible(session, name)
  } catch (error) {
    if (error instanceof PolicyDenied) return 'denied'
    throw error
  }
  if (session.readonlyVars.has(name)) return 'readonly'
  const amap = session.assocs[name]
  let stored: ShellValue
  if (amap !== undefined) {
    const key = subscript ?? '0'
    if (key === '') return 'subscript'
    const updated = { ...amap }
    updated[key] = append ? (amap[key] ?? '') + value : value
    stored = updated
  } else {
    let arr = session.arrays[name]
    if (subscript === null && arr === undefined) {
      stored = append ? (session.env[name] ?? '') + value : value
    } else {
      if (arr === undefined) {
        const scalar = session.env[name]
        // An existing scalar becomes element 0, even when empty: bash
        // resolves `x[-1]` against the length-1 array that produces.
        arr = scalar === undefined ? [] : [scalar]
      }
      let idx =
        subscript === null
          ? 0
          : elementIndex(subscript, visibleEnv(session), sessionElements(session))
      if (idx < 0) idx += arrayExtent(arr)
      if (idx < 0) return 'subscript'
      const base = append ? arrayGet(arr, idx) : ''
      stored = arrayWith(arr, idx, base + value)
    }
  }
  if (view !== null) {
    await view.set(name, stored)
    return 'ok'
  }
  seedVar(session, name, stored)
  return 'ok'
}
