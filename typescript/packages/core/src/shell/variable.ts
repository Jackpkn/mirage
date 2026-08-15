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

import type { ShellArray } from './array.ts'

/** What a shell variable can hold. */
export type ShellValue = string | ShellArray | Record<string, string>

/**
 * One bash variable attribute, spelled as its `declare` letter.
 *
 * Declaration order is the order `declare -p` prints a cluster in,
 * pinned exhaustively against bash 5.2.37 over all 72 ordered pairs of
 * `a A i l n r t u x`: `a`/`A` first, then `i n r t x`, then `l`/`u`. It
 * is bash's own internal order, not the order the letters were typed in
 * (`declare -xri` prints `-irx`), and not alphabetical.
 *
 * `-a` and `-A` are deliberately absent: whether a variable is an
 * indexed array, an associative array or a scalar is what its value
 * *is*, so storing it a second time as an attribute would let the two
 * contradict each other. `attrLetters` derives them from the value.
 */
export enum VarAttr {
  Integer = 'i',
  Nameref = 'n',
  Readonly = 'r',
  Trace = 't',
  Export = 'x',
  Lower = 'l',
  Upper = 'u',
}

/** `declare -p` print order, which is not the enum's member order. */
const ATTR_ORDER: VarAttr[] = [
  VarAttr.Integer,
  VarAttr.Nameref,
  VarAttr.Readonly,
  VarAttr.Trace,
  VarAttr.Export,
  VarAttr.Lower,
  VarAttr.Upper,
]

/** What a variable's value is, derived from the value itself. */
export enum VarKind {
  Scalar = 'scalar',
  Indexed = 'indexed',
  Assoc = 'assoc',
}

/**
 * One shell variable: a value plus the attributes set on it.
 *
 * Readonly on purpose. Every writer already computes its result on a
 * copy and hands the finished value to the session door (`[...arr]`
 * before an element write, and so on), precisely so a refused write
 * leaves nothing half-applied. Making the record immutable turns that
 * convention into something the type enforces: the only way to change a
 * variable is to hand the door a new record, so a policy gate cannot be
 * walked around by reaching into storage.
 *
 * `value` is null in bash's third state: declared with attributes but
 * *unset*, which `readonly NAME` and `export NAME` on a fresh name both
 * produce. It is not the empty string -- GNU prints `declare -r ONLY`
 * for one and `declare -r EMPTY=""` for the other, `${ONLY-d}` expands
 * to `d` while `${EMPTY-d}` does not, and `env` carries the empty one
 * but not the unset one.
 */
export interface ShellVar {
  readonly value: ShellValue | null
  readonly attrs: ReadonlySet<VarAttr>
}

const NO_ATTRS: ReadonlySet<VarAttr> = new Set()

/** Build a variable record. */
export function makeVar(
  value: ShellValue | null = null,
  attrs: ReadonlySet<VarAttr> = NO_ATTRS,
): ShellVar {
  return { value, attrs }
}

/**
 * What kind of variable this is, read off its value.
 *
 * An unset variable reads as a scalar: bash renders `declare -i n` with
 * no `-a`, so nothing but an actual array value earns the letter.
 */
export function varKind(v: ShellVar): VarKind {
  if (Array.isArray(v.value)) return VarKind.Indexed
  if (v.value !== null && typeof v.value === 'object') return VarKind.Assoc
  return VarKind.Scalar
}

/** The variable with a new value and the same attributes. */
export function withValue(v: ShellVar, value: ShellValue | null): ShellVar {
  return { value, attrs: v.attrs }
}

/**
 * The variable with one attribute turned on or off. `+attr` is the off
 * direction, which is why this takes a flag rather than being two
 * functions.
 */
export function withAttr(v: ShellVar, attr: VarAttr, on = true): ShellVar {
  const attrs = new Set(v.attrs)
  if (on) attrs.add(attr)
  else attrs.delete(attr)
  return { value: v.value, attrs }
}

/**
 * The attribute cluster `declare -p` prints for this variable.
 *
 * `-a`/`-A` come from the value's kind and lead, then the stored
 * attributes in print order. bash prints `--` for a plain scalar with
 * nothing set, which is the caller's to render since only it knows it is
 * writing a `declare` line.
 */
export function attrLetters(v: ShellVar): string {
  const kind = varKind(v)
  let lead = ''
  if (kind === VarKind.Indexed) lead = 'a'
  else if (kind === VarKind.Assoc) lead = 'A'
  return lead + ATTR_ORDER.filter((a) => v.attrs.has(a)).join('')
}
