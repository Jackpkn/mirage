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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { UsageError } from '../errors.ts'
import { toNumber } from './utils/formatting.ts'
import {
  AwkBlock,
  AwkBoolOp,
  AwkBuiltin,
  AwkCmpOp,
  CMP_OP_PATTERN,
  FIELD_PREFIX,
  PRINT_STMT,
} from './generic/awk_types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitFields(line: string, fs: string | null): string[] {
  if (fs === null || fs === ' ') return line.split(/\s+/).filter((s) => s !== '')
  if (fs === '') return Array.from(line)
  const re = fs.length === 1 ? new RegExp(escapeRegex(fs)) : new RegExp(fs)
  return line.split(re)
}

function parseProgram(program: string): [string, string] {
  const trimmed = program.trim()
  if (trimmed.startsWith('{')) {
    return ['', trimmed.slice(1).trimEnd().replace(/\}$/, '').trim()]
  }
  if (trimmed.includes('{')) {
    const idx = trimmed.indexOf('{')
    const condition = trimmed.slice(0, idx).trim()
    const action = trimmed
      .slice(idx + 1)
      .trimEnd()
      .replace(/\}$/, '')
      .trim()
    return [condition, action]
  }
  return [trimmed, '']
}

const IDENT_RE = /^[A-Za-z_]\w*$/
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/

// Whether the scraper can evaluate this token as a value. The supported
// grammar is deliberately small: a double-quoted string with no embedded
// quote, a numeric literal, a plain identifier, or a `$` field naming a
// number or an identifier. Anything else (function calls, arithmetic,
// concatenation) has no evaluator here and must be refused rather than
// echoed as its own source text.
function isSimpleOperand(tok: string): boolean {
  if (tok === '') return false
  if (tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"')) {
    return !tok.slice(1, -1).includes('"')
  }
  if (tok.startsWith(FIELD_PREFIX)) {
    const inner = tok.slice(1)
    return /^\d+$/.test(inner) || IDENT_RE.test(inner)
  }
  return IDENT_RE.test(tok) || NUMBER_RE.test(tok)
}

function reject(construct: string): never {
  throw new UsageError(`awk: unsupported construct: '${construct}'`)
}

// Split an action into its leaf statements: on `;` at brace depth zero
// and outside double quotes. A compound statement (`{ stmts }`, legal
// wherever a statement is) contributes its inner statements in place, so
// `{{print $1}}` runs `print $1` the way gawk does rather than reading as
// one unknown statement. Validator and evaluator both iterate this list,
// so they cannot disagree about where a statement ends.
function splitStatements(action: string): string[] {
  const pieces: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < action.length; i++) {
    const ch = action.charAt(i)
    if (ch === '"') {
      quoted = !quoted
    } else if (quoted) {
      continue
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth = Math.max(depth - 1, 0)
    } else if (ch === ';' && depth === 0) {
      pieces.push(action.slice(start, i))
      start = i + 1
    }
  }
  pieces.push(action.slice(start))
  const stmts: string[] = []
  for (const piece of pieces) {
    const stmt = piece.trim()
    if (stmt === '') continue
    if (stmt.startsWith('{') && stmt.endsWith('}')) {
      stmts.push(...splitStatements(stmt.slice(1, -1)))
    } else {
      stmts.push(stmt)
    }
  }
  return stmts
}

function validatePrintArgs(args: string, stmt: string): void {
  for (const tok of args.split(/,\s*/)) {
    if (!isSimpleOperand(tok.trim())) reject(stmt)
  }
}

const ASSIGN_RE = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/

// Refuse any statement the streamer would silently drop or mangle.
// `evalStatements` executes `print`, `var = value` and `var += value`;
// every other statement used to vanish (and `printf` ran as a mangled
// `print`), so an agent's script exited 0 having done nothing. Shares
// the statement split with the evaluator.
function validateAction(action: string): void {
  for (const stmt of splitStatements(action)) {
    const m = /^\w+\s*\+=\s*(.+)$/.exec(stmt)
    if (m !== null) {
      if (!isSimpleOperand((m[1] ?? '').trim())) reject(stmt)
      continue
    }
    if (!new RegExp(`^${PRINT_STMT}\\b`).test(stmt)) {
      const mSet = ASSIGN_RE.exec(stmt)
      if (mSet !== null) {
        if (!isSimpleOperand((mSet[2] ?? '').trim())) reject(stmt)
        continue
      }
    }
    if (stmt === PRINT_STMT) continue
    if (new RegExp(`^${PRINT_STMT}\\b`).test(stmt)) {
      const args = stmt.slice(PRINT_STMT.length).trim()
      if (args !== '') validatePrintArgs(args, stmt)
      continue
    }
    reject(stmt)
  }
}

function validateSimple(rawExpr: string): void {
  const expr = rawExpr.trim()
  const cmp = new RegExp(`(.+?)\\s*(${CMP_OP_PATTERN.source})\\s*(.+)`).exec(expr)
  if (cmp === null) {
    if (expr.length >= 2 && expr.startsWith('/') && expr.endsWith('/')) return
    if (!isSimpleOperand(expr)) reject(expr)
    return
  }
  const lhs = (cmp[1] ?? '').trim()
  const rhs = (cmp[3] ?? '').trim()
  if (!isSimpleOperand(lhs)) reject(expr)
  if (rhs.startsWith('"') || rhs.startsWith(FIELD_PREFIX)) {
    if (!isSimpleOperand(rhs)) reject(expr)
    return
  }
  // A bare right-hand side compares as a literal in this dialect, so any
  // word is fine; structural characters mean an expression nothing here
  // evaluates (`length(x)`, `a[1]`).
  if (/[(){}[]/.test(rhs)) reject(expr)
}

// Refuse any pattern `evalCondition` cannot actually decide. Mirrors its
// decomposition exactly (`||` first, then `&&`, then one simple
// comparison / regex / truthiness probe), so everything the evaluator
// runs is accepted and everything it would misread (`~`, arithmetic,
// parenthesized groups) is refused up front.
function validateCondition(condition: string): void {
  const cond = condition.trim()
  if (cond === '' || cond === AwkBlock.BEGIN || cond === AwkBlock.END) return
  if (cond.includes(AwkBoolOp.OR)) {
    for (const part of cond.split(AwkBoolOp.OR)) validateCondition(part)
    return
  }
  if (cond.includes(AwkBoolOp.AND)) {
    for (const part of cond.split(AwkBoolOp.AND)) validateCondition(part)
    return
  }
  validateSimple(cond)
}

export function validateAwkProgram(program: string): void {
  const [begin, main, end] = parseBlocks(program)
  const [condition, action] = main !== '' ? parseProgram(main) : (['', ''] as [string, string])
  if (begin !== '') validateAction(begin)
  if (end !== '') validateAction(end)
  validateCondition(condition)
  if (action !== '') validateAction(action)
}

function resolveToken(tok: string, fieldMap: Record<string, string>): string {
  if (tok.startsWith(FIELD_PREFIX)) {
    const inner = tok.slice(1)
    if (inner in fieldMap) {
      const ref = fieldMap[inner] ?? ''
      return fieldMap[`${FIELD_PREFIX}${ref}`] ?? ''
    }
    // An out-of-range field is empty in awk, never its own spelling.
    return fieldMap[tok] ?? ''
  }
  if (tok in fieldMap) return fieldMap[tok] ?? ''
  // An unset variable reads as the empty string, not its own name; a
  // numeric literal is its own value.
  return IDENT_RE.test(tok) ? '' : tok
}

function evalSimple(rawExpr: string, fieldMap: Record<string, string>): boolean {
  const expr = rawExpr.trim()
  const cmp = new RegExp(`(.+?)\\s*(${CMP_OP_PATTERN.source})\\s*(.+)`).exec(expr)
  if (cmp === null) {
    if (expr.startsWith('/') && expr.endsWith('/')) {
      const regex = expr.slice(1, -1)
      return new RegExp(regex).test(fieldMap[AwkBuiltin.REC] ?? '')
    }
    const val = resolveToken(expr, fieldMap)
    const n = Number.parseFloat(val)
    if (!Number.isNaN(n)) return n !== 0
    return val !== ''
  }
  const lhsRaw = (cmp[1] ?? '').trim()
  const op = (cmp[2] ?? '') as AwkCmpOp
  let rhsRaw = (cmp[3] ?? '').trim()
  rhsRaw = rhsRaw.replace(/^"|"$/g, '')
  const lhs = resolveToken(lhsRaw, fieldMap)
  const rhs =
    rhsRaw.startsWith(FIELD_PREFIX) || rhsRaw in fieldMap ? resolveToken(rhsRaw, fieldMap) : rhsRaw
  const lhsN = Number.parseFloat(lhs)
  const rhsN = Number.parseFloat(rhs)
  if (!Number.isNaN(lhsN) && !Number.isNaN(rhsN)) {
    if (op === AwkCmpOp.EQ) return lhsN === rhsN
    if (op === AwkCmpOp.NE) return lhsN !== rhsN
    if (op === AwkCmpOp.GT) return lhsN > rhsN
    if (op === AwkCmpOp.LT) return lhsN < rhsN
    if (op === AwkCmpOp.GE) return lhsN >= rhsN
    return lhsN <= rhsN
  }
  if (op === AwkCmpOp.EQ) return lhs === rhs
  if (op === AwkCmpOp.NE) return lhs !== rhs
  return false
}

function evalCondition(condition: string, fieldMap: Record<string, string>): boolean {
  const cond = condition.trim()
  if (cond === AwkBlock.BEGIN || cond === AwkBlock.END) return false
  if (cond.includes(AwkBoolOp.OR)) {
    return cond.split(AwkBoolOp.OR).some((p) => evalCondition(p, fieldMap))
  }
  if (cond.includes(AwkBoolOp.AND)) {
    return cond.split(AwkBoolOp.AND).every((p) => evalCondition(p, fieldMap))
  }
  return evalSimple(cond, fieldMap)
}

// Run an action's statements in written order. Three statement forms
// exist in this dialect: `var += value` accumulates, `var = value`
// assigns (persisting across records via `variables`, which is how
// `BEGIN {OFS=":"}` reaches every print), and `print` emits its
// arguments joined with OFS. One sequential pass, so `x = 1; print x`
// sees the assignment.
function evalStatements(
  action: string,
  fieldMap: Record<string, string>,
  accum: Record<string, number>,
  variables: Record<string, string>,
): string | null {
  const parts: string[] = []
  let printed = false
  for (const stmt of splitStatements(action)) {
    const mAdd = /^(\w+)\s*\+=\s*(.+)$/.exec(stmt)
    if (mAdd !== null) {
      const variable = mAdd[1] ?? ''
      const expr = (mAdd[2] ?? '').trim()
      const val = fieldMap[expr] ?? expr
      accum[variable] = (accum[variable] ?? 0) + toNumber(val)
      continue
    }
    if (!stmt.startsWith(PRINT_STMT)) {
      const mSet = ASSIGN_RE.exec(stmt)
      if (mSet !== null) {
        const variable = mSet[1] ?? ''
        const raw = (mSet[2] ?? '').trim()
        const val =
          raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
            ? raw.slice(1, -1)
            : resolveToken(raw, fieldMap)
        variables[variable] = val
        fieldMap[variable] = val
        continue
      }
      continue
    }
    printed = true
    const args = stmt.slice(PRINT_STMT.length).trim()
    const ofs = fieldMap.OFS ?? ' '
    if (args === '') {
      parts.push(fieldMap[AwkBuiltin.REC] ?? '')
      continue
    }
    const tokens = args.split(/,\s*/)
    const vals: string[] = []
    for (const raw of tokens) {
      const tok = raw.trim()
      if (tok.startsWith('"') && tok.endsWith('"')) {
        vals.push(tok.slice(1, -1))
      } else {
        vals.push(resolveToken(tok, fieldMap))
      }
    }
    parts.push(vals.join(ofs))
  }
  return printed ? parts.join('\n') : null
}

function buildFieldMap(
  line: string,
  fs: string | null,
  nr: number,
  variables: Record<string, string>,
): Record<string, string> {
  const fields = splitFields(line, fs)
  const fieldMap: Record<string, string> = {
    [AwkBuiltin.REC]: line,
    [AwkBuiltin.NR]: String(nr),
    [AwkBuiltin.NF]: String(fields.length),
  }
  for (let i = 0; i < fields.length; i++)
    fieldMap[`${FIELD_PREFIX}${String(i + 1)}`] = fields[i] ?? ''
  for (const [k, v] of Object.entries(variables)) fieldMap[k] = v
  return fieldMap
}

function parseBlocks(program: string): [string, string, string] {
  let begin = ''
  let end = ''
  let main = program
  const beginRe = new RegExp(`^${AwkBlock.BEGIN}\\s*\\{([^}]*)\\}\\s*([\\s\\S]*)`)
  const beginMatch = beginRe.exec(program)
  if (beginMatch !== null) {
    begin = (beginMatch[1] ?? '').trim()
    main = (beginMatch[2] ?? '').trim()
  }
  const endRe = new RegExp(`${AwkBlock.END}\\s*\\{([^}]*)\\}\\s*$`)
  const endMatch = endRe.exec(main)
  if (endMatch !== null) {
    end = (endMatch[1] ?? '').trim()
    main = main.slice(0, endMatch.index).trim()
  }
  return [begin, main, end]
}

export async function* awkStream(
  sources: AsyncIterable<Uint8Array>[],
  program: string,
  fs: string | null,
  variables: Record<string, string>,
): AsyncIterable<Uint8Array> {
  const [begin, main, end] = parseBlocks(program)
  const [condition, action] = main !== '' ? parseProgram(main) : ['', '']
  const accum: Record<string, number> = {}
  let nr = 0

  if (begin !== '') {
    const beginMap: Record<string, string> = {
      [AwkBuiltin.REC]: '',
      [AwkBuiltin.NR]: '0',
      [AwkBuiltin.NF]: '0',
      ...variables,
    }
    const result = evalStatements(begin, beginMap, accum, variables)
    if (result !== null) yield ENC.encode(result + '\n')
  }

  for (const source of sources) {
    const iter = new AsyncLineIterator(source)
    for await (const lineBytes of iter) {
      nr += 1
      if (main === '') continue
      const line = DEC.decode(lineBytes)
      const fieldMap = buildFieldMap(line, fs, nr, variables)
      if (condition !== '' && !evalCondition(condition, fieldMap)) continue
      const result = action !== '' ? evalStatements(action, fieldMap, accum, variables) : line
      if (result !== null) yield ENC.encode(result + '\n')
    }
  }

  if (end !== '') {
    const endMap: Record<string, string> = {
      [AwkBuiltin.REC]: '',
      [AwkBuiltin.NR]: String(nr),
      [AwkBuiltin.NF]: '0',
      ...variables,
    }
    for (const [k, v] of Object.entries(accum)) endMap[k] = String(v)
    const result = evalStatements(end, endMap, accum, variables)
    if (result !== null) yield ENC.encode(result + '\n')
  }
}
