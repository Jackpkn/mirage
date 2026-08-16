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

import {
  ARITH_ASSIGN_OPS,
  ARITH_ELEM,
  ARITH_MAX_DEPTH,
  ARITH_NAME,
  ARITH_TOKEN,
} from './constants.ts'
import { ArithError } from './errors.ts'
import type { ArithResult, ArithWrite, ElementOps } from './types.ts'

type ArithTarget = { kind: 'var'; name: string } | { kind: 'elem'; name: string; sub: string }

type ArithNode =
  | { kind: 'num'; value: bigint }
  | ArithTarget
  | { kind: 'comma'; parts: ArithNode[] }
  | { kind: 'assign'; target: ArithTarget; op: string; rhs: ArithNode }
  | { kind: 'ternary'; cond: ArithNode; then: ArithNode; other: ArithNode }
  | { kind: 'logic'; op: string; left: ArithNode; right: ArithNode }
  | { kind: 'binop'; op: string; left: ArithNode; right: ArithNode }
  | { kind: 'unary'; op: string; operand: ArithNode }
  | { kind: 'pre'; op: string; target: ArithTarget }
  | { kind: 'post'; op: string; target: ArithTarget }

/**
 * Index of the `]` closing the `[` at `start`, quote-aware. Quotes
 * matter because an associative key may hold a bracket (`m["a]b"]`);
 * nesting matters because an indexed subscript may hold another
 * reference (`a[b[0]]`).
 */
function matchingBracket(expr: string, start: number): number {
  let depth = 0
  let i = start
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === '"' || ch === "'") {
      const close = expr.indexOf(ch, i + 1)
      if (close === -1) break
      i = close + 1
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  throw new ArithError('syntax error: "]" expected')
}

function tokenize(expr: string): string[] {
  const tokens: string[] = []
  const scanner = new RegExp(ARITH_TOKEN.source, 'y')
  let pos = 0
  while (pos < expr.length) {
    scanner.lastIndex = pos
    const match = scanner.exec(expr)
    if (match === null) throw new ArithError(`syntax error: invalid character "${expr[pos] ?? ''}"`)
    const [, num, name, op, ws, bad] = match
    const end = scanner.lastIndex
    if (name !== undefined && expr[end] === '[') {
      // A name adjacent to a bracket is one element reference, so the
      // subscript rides inside the token: its interior is not
      // arithmetic (an associative key can be any text at all) and
      // only the resolver knows which grammar applies.
      const close = matchingBracket(expr, end)
      tokens.push(expr.slice(match.index, close + 1))
      pos = close + 1
      continue
    }
    pos = end
    if (ws !== undefined) continue
    if (bad !== undefined) throw new ArithError(`syntax error: invalid character "${bad}"`)
    const tok = num ?? name ?? op
    if (tok !== undefined) tokens.push(tok)
  }
  return tokens
}

/** The lvalue node one token spells, or null when it spells none. */
function targetNode(tok: string): ArithTarget | null {
  if (ARITH_NAME.test(tok)) return { kind: 'var', name: tok }
  const elem = ARITH_ELEM.exec(tok)
  if (elem?.[1] !== undefined && elem[2] !== undefined) {
    return { kind: 'elem', name: elem[1], sub: elem[2] }
  }
  return null
}

function wrap(value: bigint): bigint {
  return BigInt.asIntN(64, value)
}

function baseDigit(ch: string, base: number): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48
  if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 97 + 10
  if (ch >= 'A' && ch <= 'Z') {
    // Below base 37 upper- and lowercase are interchangeable; above,
    // uppercase continues the digit range (bash base#value rules).
    return ch.charCodeAt(0) - 65 + (base <= 36 ? 10 : 36)
  }
  if (ch === '@') return 62
  return 63
}

function parseBaseLiteral(text: string): bigint {
  const hash = text.indexOf('#')
  const base = Number(text.slice(0, hash))
  const digits = text.slice(hash + 1)
  if (base < 2 || base > 64)
    throw new ArithError(`invalid arithmetic base (error token is "${text}")`)
  let value = 0n
  for (const ch of digits) {
    const digit = baseDigit(ch, base)
    if (digit >= base) throw new ArithError(`value too great for base (error token is "${text}")`)
    value = value * BigInt(base) + BigInt(digit)
  }
  return value
}

function parseLiteral(text: string): bigint {
  if (text.includes('#')) return parseBaseLiteral(text)
  if (text.toLowerCase().startsWith('0x')) return BigInt(text)
  if (text.startsWith('0') && text !== '0') {
    if (!/^[0-7]+$/.test(text))
      throw new ArithError(`value too great for base (error token is "${text}")`)
    return BigInt(`0o${text.slice(1)}`)
  }
  if (!/^-?\d+$/.test(text)) throw new ArithError(`syntax error: unexpected token "${text}"`)
  return BigInt(text)
}

// Recursive-descent parser producing ArithNode trees. Grammar mirrors bash
// arithmetic precedence (comma, assignment, ternary, ||, &&, |, ^, &,
// equality, relational, shift, additive, multiplicative, **, unary,
// ++/--, primary). Evaluation is separate so &&/||/ternary can
// short-circuit side effects.
class ArithParser {
  private pos = 0
  constructor(private readonly tokens: string[]) {}

  private peek(): string | null {
    return this.tokens[this.pos] ?? null
  }

  private take(): string {
    const tok = this.tokens[this.pos]
    if (tok === undefined) throw new ArithError('syntax error: operand expected')
    this.pos++
    return tok
  }

  private expect(tok: string): void {
    if (this.take() !== tok) throw new ArithError(`syntax error: "${tok}" expected`)
  }

  parse(): ArithNode {
    const node = this.comma()
    if (this.peek() !== null)
      throw new ArithError(`syntax error: unexpected token "${String(this.peek())}"`)
    return node
  }

  private comma(): ArithNode {
    const parts = [this.assign()]
    while (this.peek() === ',') {
      this.take()
      parts.push(this.assign())
    }
    const first = parts[0]
    if (parts.length === 1 && first !== undefined) return first
    return { kind: 'comma', parts }
  }

  private assign(): ArithNode {
    const tok = this.peek()
    const next = this.tokens[this.pos + 1]
    if (tok !== null && next !== undefined && ARITH_ASSIGN_OPS.has(next)) {
      const target = targetNode(tok)
      if (target !== null) {
        this.take()
        const op = this.take()
        return { kind: 'assign', target, op, rhs: this.assign() }
      }
    }
    return this.ternary()
  }

  private ternary(): ArithNode {
    const cond = this.logicOr()
    if (this.peek() !== '?') return cond
    this.take()
    const then = this.assign()
    this.expect(':')
    const other = this.assign()
    return { kind: 'ternary', cond, then, other }
  }

  private logicOr(): ArithNode {
    let node = this.logicAnd()
    while (this.peek() === '||') {
      this.take()
      node = { kind: 'logic', op: '||', left: node, right: this.logicAnd() }
    }
    return node
  }

  private logicAnd(): ArithNode {
    let node = this.bitOr()
    while (this.peek() === '&&') {
      this.take()
      node = { kind: 'logic', op: '&&', left: node, right: this.bitOr() }
    }
    return node
  }

  private bitOr(): ArithNode {
    let node = this.bitXor()
    while (this.peek() === '|') {
      this.take()
      node = { kind: 'binop', op: '|', left: node, right: this.bitXor() }
    }
    return node
  }

  private bitXor(): ArithNode {
    let node = this.bitAnd()
    while (this.peek() === '^') {
      this.take()
      node = { kind: 'binop', op: '^', left: node, right: this.bitAnd() }
    }
    return node
  }

  private bitAnd(): ArithNode {
    let node = this.equality()
    while (this.peek() === '&') {
      this.take()
      node = { kind: 'binop', op: '&', left: node, right: this.equality() }
    }
    return node
  }

  private equality(): ArithNode {
    let node = this.relational()
    while (this.peek() === '==' || this.peek() === '!=') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.relational() }
    }
    return node
  }

  private relational(): ArithNode {
    let node = this.shift()
    for (;;) {
      const tok = this.peek()
      if (tok !== '<' && tok !== '<=' && tok !== '>' && tok !== '>=') break
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.shift() }
    }
    return node
  }

  private shift(): ArithNode {
    let node = this.additive()
    while (this.peek() === '<<' || this.peek() === '>>') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.additive() }
    }
    return node
  }

  private additive(): ArithNode {
    let node = this.multiplicative()
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.multiplicative() }
    }
    return node
  }

  private multiplicative(): ArithNode {
    let node = this.power()
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.power() }
    }
    return node
  }

  private power(): ArithNode {
    const node = this.unary()
    if (this.peek() === '**') {
      this.take()
      return { kind: 'binop', op: '**', left: node, right: this.power() }
    }
    return node
  }

  private unary(): ArithNode {
    const tok = this.peek()
    if (tok === '!' || tok === '~' || tok === '-' || tok === '+') {
      this.take()
      return { kind: 'unary', op: tok, operand: this.unary() }
    }
    if (tok === '++' || tok === '--') {
      this.take()
      const target = targetNode(this.take())
      if (target === null) throw new ArithError(`syntax error: "${tok}" requires a variable`)
      return { kind: 'pre', op: tok, target }
    }
    return this.postfix()
  }

  private postfix(): ArithNode {
    const node = this.primary()
    const tok = this.peek()
    if ((tok === '++' || tok === '--') && (node.kind === 'var' || node.kind === 'elem')) {
      this.take()
      return { kind: 'post', op: tok, target: node }
    }
    return node
  }

  private primary(): ArithNode {
    const tok = this.take()
    if (tok === '(') {
      const node = this.comma()
      this.expect(')')
      return node
    }
    const target = targetNode(tok)
    if (target !== null) return target
    return { kind: 'num', value: parseLiteral(tok) }
  }
}

// Evaluates the ArithNode tree against an env, recording assignments.
// Reads resolve through `updates` first, then `env`; every write lands in
// `updates` (or `elemUpdates` for an element lvalue) so the caller
// decides what to apply to the session (bash arithmetic assignments are
// real assignments). `writes` keeps the one ordered record across both
// kinds, keyed by target and moved to the end on each write, so the
// caller lands them in the order the expression made them.
class ArithEvaluator {
  constructor(
    private readonly env: Readonly<Record<string, string>>,
    private readonly updates: Record<string, string>,
    private readonly elemUpdates: Map<string, string>,
    private readonly writes: Map<string, ArithWrite>,
    private readonly depth: number,
    private readonly elements: ElementOps | null,
  ) {}

  private coerce(raw: string | null): bigint {
    const text = (raw ?? '').trim()
    if (text === '') return 0n
    try {
      return parseLiteral(text)
    } catch {
      if (this.depth >= ARITH_MAX_DEPTH)
        throw new ArithError(`expression recursion level exceeded (error token is "${text}")`)
      const { value } = evaluateArith(
        text,
        { ...this.env, ...this.updates },
        this.depth + 1,
        this.elements,
      )
      return value
    }
  }

  private lookup(name: string): bigint {
    const pending = this.updates[name] ?? this.env[name]
    if (pending !== undefined) return this.coerce(pending)
    // A bare array name reads as element 0 (`a=(4 5)` then `$((a))` is
    // 4); the env holds scalars only, so the element resolver answers
    // for the arrays.
    return this.coerce(this.elements === null ? null : this.elements.read(name, '0'))
  }

  private elemKey(name: string, sub: string): string {
    if (this.elements === null) {
      throw new ArithError('syntax error: operand expected (error token is "[")')
    }
    return this.elements.resolve(name, sub, { ...this.env, ...this.updates })
  }

  private readTarget(target: ArithTarget): bigint {
    if (target.kind === 'var') return this.lookup(target.name)
    const key = this.elemKey(target.name, target.sub)
    const pending = this.elemUpdates.get(`${target.name} ${key}`)
    if (pending !== undefined) return this.coerce(pending)
    return this.coerce(this.elements === null ? null : this.elements.read(target.name, key))
  }

  private writeTarget(target: ArithTarget, value: bigint): void {
    const text = value.toString()
    if (target.kind === 'var') {
      this.updates[target.name] = text
      this.record(target.name, null, text)
      return
    }
    const key = this.elemKey(target.name, target.sub)
    this.elemUpdates.set(`${target.name} ${key}`, text)
    this.record(target.name, key, text)
  }

  private record(name: string, key: string | null, value: string): void {
    const slot = key === null ? name : `${name} ${key}`
    this.writes.delete(slot)
    this.writes.set(slot, { name, key, value })
  }

  run(node: ArithNode): bigint {
    switch (node.kind) {
      case 'num':
        return node.value
      case 'var':
      case 'elem':
        return this.readTarget(node)
      case 'comma': {
        let value = 0n
        for (const part of node.parts) value = this.run(part)
        return value
      }
      case 'assign': {
        const rhsVal = this.run(node.rhs)
        const value =
          node.op === '='
            ? rhsVal
            : this.applyBinop(node.op.slice(0, -1), this.readTarget(node.target), rhsVal)
        this.writeTarget(node.target, value)
        return value
      }
      case 'ternary':
        return this.run(node.cond) !== 0n ? this.run(node.then) : this.run(node.other)
      case 'logic': {
        const lval = this.run(node.left)
        if (node.op === '&&') return lval !== 0n && this.run(node.right) !== 0n ? 1n : 0n
        return lval !== 0n || this.run(node.right) !== 0n ? 1n : 0n
      }
      case 'binop':
        return this.applyBinop(node.op, this.run(node.left), this.run(node.right))
      case 'unary': {
        const value = this.run(node.operand)
        if (node.op === '!') return value !== 0n ? 0n : 1n
        if (node.op === '~') return wrap(~value)
        if (node.op === '-') return wrap(-value)
        return value
      }
      case 'pre': {
        const value = wrap(this.readTarget(node.target) + (node.op === '++' ? 1n : -1n))
        this.writeTarget(node.target, value)
        return value
      }
      case 'post': {
        const value = this.readTarget(node.target)
        this.writeTarget(node.target, wrap(value + (node.op === '++' ? 1n : -1n)))
        return value
      }
    }
  }

  private applyBinop(op: string, a: bigint, b: bigint): bigint {
    switch (op) {
      case '+':
        return wrap(a + b)
      case '-':
        return wrap(a - b)
      case '*':
        return wrap(a * b)
      case '/':
        if (b === 0n) throw new ArithError('division by 0')
        return wrap(a / b)
      case '%':
        if (b === 0n) throw new ArithError('division by 0')
        return wrap(a % b)
      case '**':
        if (b < 0n) throw new ArithError('exponent less than 0')
        return wrap(a ** b)
      case '<<':
        return wrap(a << (b & 63n))
      case '>>':
        return wrap(a >> (b & 63n))
      case '&':
        return wrap(a & b)
      case '|':
        return wrap(a | b)
      case '^':
        return wrap(a ^ b)
      case '==':
        return a === b ? 1n : 0n
      case '!=':
        return a !== b ? 1n : 0n
      case '<':
        return a < b ? 1n : 0n
      case '<=':
        return a <= b ? 1n : 0n
      case '>':
        return a > b ? 1n : 0n
      case '>=':
        return a >= b ? 1n : 0n
      default:
        throw new ArithError(`unsupported operator "${op}"`)
    }
  }
}

/**
 * Evaluate a bash arithmetic expression.
 *
 * Implements bash's arithmetic grammar over 64-bit wrapping integers
 * (BigInt): comma sequences, assignment operators, the ternary,
 * short-circuit `&&`/`||`, bitwise/relational/shift/additive/
 * multiplicative operators, right-associative `**`, unary operators, and
 * prefix/postfix `++`/`--`. BigInt division/modulo already truncate
 * toward zero like C. A variable whose value is not a plain integer
 * literal is evaluated recursively like bash (`x="1+2"; $((x))` is 3).
 * `base#value` literals are not supported. Element references (`a[i]`,
 * `m[key]`) resolve and assign through `elements`; with null every
 * subscript is a syntax error, which is what an evaluation with no
 * session behind it can honestly say. Returns the value plus the scalar
 * and element assignments made, for the caller to apply to the session.
 * Throws ArithError on syntax errors, division by zero, or a negative
 * exponent.
 */
export function evaluateArith(
  expr: string,
  env: Readonly<Record<string, string>>,
  depth = 0,
  elements: ElementOps | null = null,
): ArithResult {
  const tokens = tokenize(expr)
  if (tokens.length === 0) return { value: 0n, writes: [] }
  const node = new ArithParser(tokens).parse()
  const updates: Record<string, string> = {}
  const elemUpdates = new Map<string, string>()
  const writes = new Map<string, ArithWrite>()
  const value = new ArithEvaluator(env, updates, elemUpdates, writes, depth, elements).run(node)
  return { value, writes: [...writes.values()] }
}
