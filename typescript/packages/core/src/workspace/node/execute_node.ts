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

import { seedVar } from '../session/state.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { PolicyDecision } from '../../runtime/policy/index.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { makeAbortError } from '../abort.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { assignmentStatus, finishStatement } from '../executor/statement.ts'
import {
  getCaseItems,
  getCaseWord,
  getDeclarationKeyword,
  getCforParts,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getPipelineCommands,
  getRedirects,
  getText,
  getUnsetArgs,
  getWhileParts,
} from '../../shell/helpers.ts'
import { JobTable } from '../../shell/job_table/index.ts'
import { ERREXIT_EXEMPT_TYPES, NodeType as NT, Redirect, RedirectKind } from '../../shell/types.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { type ExecuteFn, expandArith, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import { evaluateArith } from '../../shell/arith.ts'
import {
  type ShellArray,
  arrayExtent,
  arrayGet,
  arraySet,
  buildAssocLiteral,
  buildIndexedLiteral,
} from '../../shell/array.ts'
import { ArithError, ExitSignal, ReadonlyError } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import { arrayIndex } from '../expand/variable.ts'
import { assignElement } from '../session/elements.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import { wordText } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import {
  type CforEval,
  handleCase,
  handleCfor,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import {
  handleExport,
  handleDeclareFunctions,
  handleDeclarePrint,
  handleLocal,
  handleReadonly,
  handleTest,
  handleUnset,
  noteLocalArray,
} from '../executor/builtins/index.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { resolveGlobs } from '../expand/globs.ts'
import { expandDoubleBracket, expandTestExpr } from './test_expr.ts'
import { executeProgram } from './program.ts'
import { executeCommand } from './command_dispatch.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { SessionView } from '../../ops/types.ts'
import {
  elementIndex,
  ensureVarVisible,
  sessionElements,
  sessionView,
  setAttr,
  visibleEnv,
} from '../session/state.ts'
import { type ShellValue, VarAttr } from '../../shell/variable.ts'
import { traceAssignment } from '../../shell/xtrace.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { type ExecuteNodeOpts, pump } from '../executor/jobs.ts'

const STREAMING_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.PROGRAM,
  NodeKind.COMPOUND,
  NodeKind.LIST,
  NodeKind.SUBSHELL,
  NodeKind.IF,
  NodeKind.FOR,
  NodeKind.CFOR,
  NodeKind.SELECT,
  NodeKind.WHILE,
  NodeKind.UNTIL,
  NodeKind.CASE,
  NodeKind.NEGATED,
])

type Result = [ByteSource | null, IOResult, ExecutionNode]
type Recurse = (
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<Result>

/**
 * Layer per-call overrides onto the walker's deps.
 *
 * Written field by field rather than spread so an explicitly undefined
 * override cannot erase a dep under exactOptionalPropertyTypes.
 */
function withOpts(base: ExecuteNodeDeps, opts?: ExecuteNodeOpts): ExecuteNodeDeps {
  if (opts === undefined) return base
  const next: ExecuteNodeDeps = { ...base }
  if (opts.sink !== undefined) next.sink = opts.sink
  if (opts.signal !== undefined) next.signal = opts.signal
  return next
}

/**
 * One assignment through the session door; denial is fatal.
 *
 * Every assignment spelling (scalar, array literal, subscript, append)
 * computes its resulting value and stores through `view.set`, so the
 * gate and the storage invariant live in the door, not here. Denial
 * mirrors the readonly case: a fatal variable-assignment error that
 * abandons the rest of the line.
 */
async function assignVar(view: SessionView, key: string, value: ShellValue): Promise<void> {
  try {
    await view.set(key, value)
  } catch (err) {
    if (err instanceof PolicyDenied) {
      const denied = new TextEncoder().encode(`${err.message}\n`)
      throw new ExitSignal(1, denied, null, 1)
    }
    if (err instanceof ArithError) {
      // The `-i` coercion refused the text. GNU aborts the line the way
      // a bad subscript does, in the evaluator's voice with the text led.
      throw new ExitSignal(1, new TextEncoder().encode(`bash: ${err.message}\n`), null, 1)
    }
    throw err
  }
}

/**
 * Evaluate one C-style for expression slot: the slot's integer value,
 * or the default for an empty slot (1 for the condition so `for
 * ((;;))` loops, 0 for init/update). Re-raises ArithError with the
 * expression text prepended so the loop can print bash's
 * `((: expr: reason` diagnostic, and throws ReadonlyError when the
 * expression assigns to a readonly variable.
 */
async function evalCforExpr(
  expr: TSNodeLike | null,
  dflt: number,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<number> {
  if (expr === null) return dflt
  const text = await expandArith(expr, session, executeFn, callStack, view)
  let result: ArithResult
  try {
    // Reads resolve against the visible env so a hidden name counts as
    // unset; a hidden write refuses through the session door
    // (ensureVarVisible), caught by the loop beside ReadonlyError.
    result = evaluateArith(text, visibleEnv(session), 0, sessionElements(session))
  } catch (err) {
    if (!(err instanceof ArithError)) throw err
    throw new ArithError(`${text}: ${err.message}`)
  }
  for (const write of result.writes) {
    ensureVarVisible(session, write.name)
    if (session.readonlyVars.has(write.name)) throw new ReadonlyError(write.name)
  }
  // Through the door, so a preSession rule governs an arithmetic assignment
  // exactly as it governs `X=1`; in evaluation order, so a bare name and
  // its element 0 land as the expression wrote them.
  for (const write of result.writes) {
    await assignElement(session, view ?? null, write.name, write.key, write.value)
  }
  return Number(result.value)
}

// Array-literal elements behave like any other shell word list: command
// substitutions word-split and globs resolve to matches
// (`a=($(cmd) /data/*.txt)`), with zero-match globs kept literal.
async function expandArrayItems(
  arrayNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
): Promise<string[]> {
  const classified = await expandAndClassify(
    arrayNode.namedChildren,
    session,
    executeFn,
    registry,
    session.cwd,
    callStack,
    sessionView(session, registry.policies),
  )
  const resolved = await resolveGlobs(
    classified,
    registry,
    session.shellOptions.noglob === true,
    namespace,
  )
  return resolved.map((w) => wordText(w))
}

async function recurseReassociated(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  redirects: readonly Redirect[],
  right: TSNodeLike,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (node !== right) return recurse(node, session, stdin, callStack)
  const [expanded, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
    sessionView(session, registry.policies),
  )
  let [stdout, io, execNode] = await handleRedirect(
    recurse,
    dispatch,
    right,
    expanded,
    session,
    stdin,
    callStack,
  )
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}

async function recursePipeStderr(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  targets: readonly TSNodeLike[],
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (!targets.includes(node) || nodeKind(node) !== NodeKind.REDIRECT) {
    return recurse(node, session, stdin, callStack)
  }
  const [command, redirects] = getRedirects(node)
  redirects.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  const [expanded, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
    sessionView(session, registry.policies),
  )
  let [stdout, io, execNode] = await handleRedirect(
    recurse,
    dispatch,
    command,
    expanded,
    session,
    stdin,
    callStack,
  )
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}

export interface ExecuteNodeDeps {
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  ensureOpen?: (resource: Resource) => Promise<void>
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: PolicyDecision
  signal?: AbortSignal
  /**
   * Console this node writes its output to as it is produced.
   * When set, the node emits and returns no stdout; when unset
   * it returns stdout as a value, which is what capture sites
   * (command substitution, pipe stages, redirects) rely on.
   */
  sink?: JobConsole
}

/**
 * Mark every name a `-x` declaration stored as exported.
 *
 * `declare -x NAME` marks an existing name without touching its value and
 * `declare -x NAME=v` assigns then marks, so the stamp lands after the
 * assignment either way. Staged array literals are stamped too, since an
 * array is as exportable as a scalar: GNU answers `declare -x A=(a b)`
 * with `declare -ax A=([0]="a" [1]="b")`, and reading only `assignments`
 * left every `declare -x NAME=(...)` unmarked.
 *
 * Shared by the readonly and the plain declaration branch because
 * `declare -rx X=1` goes down the readonly one and still owes the export
 * attribute.
 *
 * Only the names the handler reports storing are marked, and marking is
 * not gated on the aggregate status: a declaration keeps its valid
 * operands when a sibling refuses, so `declare -x GOOD=1 1BAD=x` exits 1
 * and still answers `declare -x GOOD="1"`.
 *
 * A name that carried a value went through `view.set`, so its mark rides
 * on that decision; a bare name did not, and on an *existing* name the
 * handler writes nothing at all, so the mark is the only session write
 * there is and has to clear `pre_session` itself. Stamping it through
 * `setAttr` let `declare -x AWS_TOKEN` export a host-seeded credential
 * the deployment had refused.
 */
const SUBSCRIPT_LITERAL_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER, NT.ERROR])

/**
 * The expanded subscript text of one `name[...]=` assignment.
 *
 * A purely literal subscript keeps its raw spelling, spaces included
 * (bash stores `m[ k ]` under the key `" k "`); anything carrying an
 * expansion or quoting expands node by node so `m[$k]` and `m["a b"]`
 * resolve with quote removal. The associative path uses the result as
 * the key verbatim; the indexed path evaluates it as arithmetic.
 */
async function subscriptKeyText(
  subscriptNode: TSNodeLike,
  name: string,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string> {
  const inner = subscriptNode.namedChildren.filter((sc) => sc.type !== NT.VARIABLE_NAME)
  const raw = subscriptNode.text.slice(name.length + 1, -1)
  if (inner.length === 0 || inner.every((sc) => SUBSCRIPT_LITERAL_TYPES.has(sc.type))) {
    return raw
  }
  const parts: string[] = []
  for (const sc of inner) {
    parts.push(await expandNode(sc, session, executeFn, callStack, view))
  }
  return parts.join('')
}

/**
 * Fold kind-conversion refusals into a declaration's result.
 *
 * GNU reports `cannot convert indexed to associative array` per refused
 * name on stderr and fails the builtin with 1 while the other operands
 * still declare, so the refusals ride the handler's own result rather
 * than replacing it.
 */
function mergeConversionErrors(result: Result, errors: readonly string[]): Result {
  if (errors.length === 0) return result
  const [stream, io, node] = result
  const extra = new TextEncoder().encode(errors.join('\n') + '\n')
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array(0)
  const merged = new Uint8Array(prior.length + extra.length)
  merged.set(prior, 0)
  merged.set(extra, prior.length)
  const newIo = new IOResult({
    exitCode: 1,
    stderr: merged,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
  })
  return [stream, newIo, new ExecutionNode({ command: node.command, exitCode: 1, stderr: merged })]
}

// Every letter GNU's `declare` accepts, so a typo refuses with the usage
// line instead of being silently dropped. `-a`/`-A` are kinds, not
// attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
// /`-I` are modes the handlers read. `-n` is accepted and stored, but
// aliasing (reads and writes through the reference) is not wired: it is
// a separate seam through every expansion site, so a name carrying it
// declares and prints, and nothing more, rather than a partial alias
// that works in some spellings and not others.
const DECLARE_LETTERS: ReadonlySet<string> = new Set('aAfFgiIlnprtux')
const DECLARE_USAGE =
  'declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]'
// The stored attributes a `-letter` / `+letter` toggles.
const ATTR_LETTERS: ReadonlyMap<string, VarAttr> = new Map([
  ['i', VarAttr.Integer],
  ['l', VarAttr.Lower],
  ['u', VarAttr.Upper],
  ['n', VarAttr.Nameref],
  ['t', VarAttr.Trace],
  ['x', VarAttr.Export],
  ['r', VarAttr.Readonly],
])

/** The attributes the given letters name, in the order given, skipping
 * letters that name none (kinds and modes are not attributes). */
function attrsFor(letters: string, has: (c: string) => boolean): VarAttr[] {
  const out: VarAttr[] = []
  for (const c of letters) {
    const attr = ATTR_LETTERS.get(c)
    if (attr !== undefined && has(c)) out.push(attr)
  }
  return out
}

/**
 * The refusal a `declare` family option cluster earns, if any.
 *
 * An unknown letter is GNU's `invalid option` plus the usage line, exit
 * 2, and it wins over every other check because bash refuses the
 * cluster before it looks at a single operand.
 */
function declareOptionRefusal(
  cmd: string,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
): Result | null {
  const bad = [...flagChars, ...plusChars]
    .sort(compareCodePoints)
    .find((c) => !DECLARE_LETTERS.has(c))
  if (bad === undefined) return null
  const sign = flagChars.has(bad) ? '-' : '+'
  const err = new TextEncoder().encode(
    `bash: ${cmd}: ${sign}${bad}: invalid option\n${DECLARE_USAGE}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 2, stderr: err }),
  ]
}

/**
 * The per-name refusals a `+letter` earns after the operands are known.
 *
 * Two letters cannot be taken off. `+r` on a readonly name is
 * `declare: R: readonly variable`, exit 1, and the name stays frozen.
 * `+a` / `+A` on an array is `cannot destroy array variables in this
 * way`, exit 1, since the kind is what the value is, not a mark. Both
 * are pinned on 5.2.37 and neither stops the other operands from
 * declaring; the first refusal is what the builtin reports.
 */
function plusRefusals(
  cmd: string,
  session: Session,
  view: SessionView,
  plusChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
): Result | null {
  if (!plusChars.has('r') && !plusChars.has('a') && !plusChars.has('A')) return null
  const names = assignments.map((a) => a.split('=')[0] ?? a)
  for (const { name } of staged ?? []) names.push(name)
  for (const name of names) {
    if (plusChars.has('r') && view.isReadonly(name)) {
      const err = new TextEncoder().encode(`bash: ${cmd}: ${name}: readonly variable\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
      ]
    }
    if (
      (plusChars.has('a') && Object.hasOwn(session.arrays, name)) ||
      (plusChars.has('A') && Object.hasOwn(session.assocs, name))
    ) {
      const err = new TextEncoder().encode(
        `bash: ${cmd}: ${name}: cannot destroy array variables in this way\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
      ]
    }
  }
  return null
}

/**
 * Apply every `-attr` / `+attr` letter to the names a declaration
 * stored, on top of the export stamp.
 *
 * The letters that shape a value (`-i -l -u`) are stored as attributes
 * and applied by the door on every *later* write, which is GNU's rule:
 * `v=MiXeD; declare -l v` keeps `MiXeD`, and the next `v=ABC` stores
 * `abc`. So this stamps and never rewrites. `-l` and `-u` are exclusive:
 * setting one clears the other, and a cluster naming both (`-lu`, `-ul`)
 * sets neither, both pinned on 5.2.37. A `+` letter clears; `+r` is
 * refused earlier on a readonly name and a no-op otherwise, so it is not
 * an off toggle. Through the gated mark door for every name, covered or
 * not: the handler already cleared the gate for these names, so this is
 * one redundant policy call per attribute, and it keeps this stamp out
 * of the ungated-write allowlist that `setAttr` sites must justify.
 */
async function stampAttrs(
  session: Session,
  view: SessionView,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
  stored: readonly string[],
): Promise<Result | null> {
  const refused = await stampExport(session, view, flagChars, assignments, staged, stored)
  if (refused !== null) return refused
  let onAttrs = attrsFor('ilunt', (c) => flagChars.has(c) && !plusChars.has(c))
  if (flagChars.has('l') && flagChars.has('u')) {
    onAttrs = onAttrs.filter((a) => a !== VarAttr.Lower && a !== VarAttr.Upper)
  }
  const offAttrs = attrsFor('iluntx', (c) => plusChars.has(c))
  if (onAttrs.length === 0 && offAttrs.length === 0) return null
  try {
    for (const name of stored) {
      for (const attr of onAttrs) {
        await view.mark(name, attr, true)
        // `-l` displaces `-u` and vice versa; the record keeps one.
        if (attr === VarAttr.Lower) await view.mark(name, VarAttr.Upper, false)
        else if (attr === VarAttr.Upper) await view.mark(name, VarAttr.Lower, false)
      }
      for (const attr of offAttrs) await view.mark(name, attr, false)
    }
  } catch (err) {
    if (!(err instanceof PolicyDenied)) throw err
    const denied = new TextEncoder().encode(`${err.message}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: denied }),
      new ExecutionNode({ command: 'declare', exitCode: 1, stderr: denied }),
    ]
  }
  return null
}

async function stampExport(
  session: Session,
  view: SessionView,
  flagChars: ReadonlySet<string>,
  assignments: readonly string[],
  staged: readonly { name: string }[] | null,
  stored: readonly string[],
): Promise<Result | null> {
  if (!flagChars.has('x')) return null
  const covered = new Set<string>()
  for (const a of assignments) {
    const eq = a.indexOf('=')
    if (eq >= 0) covered.add(a.slice(0, eq))
  }
  for (const { name } of staged ?? []) covered.add(name)
  for (const name of stored) {
    if (covered.has(name)) {
      setAttr(session, name, VarAttr.Export)
      continue
    }
    try {
      await view.mark(name, VarAttr.Export, true)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const encoded = new TextEncoder().encode(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: encoded }),
        new ExecutionNode({ command: 'declare', exitCode: 1, stderr: encoded }),
      ]
    }
  }
  return null
}

export async function executeNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const { sink, ...captureDeps } = deps
  const recurse = (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
    opts?: ExecuteNodeOpts,
  ): Promise<Result> => executeNode(withOpts(captureDeps, opts), n, s, i, cs)
  const stream =
    sink === undefined
      ? recurse
      : (
          n: TSNodeLike,
          s: Session,
          i: ByteSource | null,
          cs: CallStack | null,
          opts?: ExecuteNodeOpts,
        ): Promise<Result> => executeNode(withOpts(deps, opts), n, s, i, cs)

  const { dispatch, registry, jobTable, executeFn, agentId } = deps
  const kind = nodeKind(node)

  // `set -n` reads without executing, and it stops *everything* after
  // it, at every depth: GNU answers `if true; then set -n; echo BAD; fi`
  // and `f(){ set -n; echo BAD; }; f` with nothing at all. Stated here,
  // at the one door every node goes through, rather than in each
  // statement runner — the program loop, the subshell body, a group, a
  // function body and every loop body are five places for one rule to
  // drift, and it did: the check lived in the program loop alone, so
  // `set -n` worked flat and did nothing one construct deep. The program
  // loop keeps its own `break` as the reader-level stop, which is also
  // what silences `set -v` for the lines it never reads.
  if (session.shellOptions.noexec === true) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  if (deps.signal?.aborted === true || session.abortSignal?.aborted === true) {
    throw makeAbortError()
  }
  session.errexitImmune = false

  // A sink turns this walk from "return your output" into "write your
  // output". Sequencing constructs pass it to their children so each
  // statement lands as it finishes; everything else runs unchanged and
  // has its result drained here. Only STREAMING_KINDS inherit a sink,
  // so capture sites keep receiving their output as a value.
  if (sink !== undefined && !STREAMING_KINDS.has(kind)) {
    const [stdout, io, execNode] = await recurse(node, session, stdin, callStack)
    await pump(sink, Channel.STDOUT, stdout)
    const stderr = await io.materializeStderr()
    if (stderr.byteLength > 0) {
      await sink.emit(Channel.STDERR, stderr)
      // Cleared so the job's tail does not emit it a second time.
      io.stderr = null
    }
    return [null, io, execNode]
  }

  if (kind === NodeKind.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (kind === NodeKind.PROGRAM) {
    return executeProgram(stream, node, session, stdin, callStack, jobTable, agentId)
  }

  if (kind === NodeKind.COMMAND) {
    return executeCommand(
      recurse,
      dispatch,
      registry,
      deps.namespace,
      executeFn,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      deps.ensureOpen,
      deps.runtimeBindings,
      deps.routingDecision,
      deps.signal,
    )
  }

  if (kind === NodeKind.PIPELINE) {
    const [pipeCommands, stderrFlags] = getPipelineCommands(node)
    let commands = pipeCommands
    // `! a | b` parses as pipeline(negated_command(a), b) but bash
    // negates the WHOLE pipeline's exit status.
    const first = commands[0]
    const negated = first?.type === NT.NEGATED_COMMAND
    if (negated) {
      commands = [getNegatedCommand(first), ...commands.slice(1)]
    }
    let pipeRecurse = recurse
    if (stderrFlags.some(Boolean)) {
      const targets = commands.filter((_, i) => stderrFlags[i] === true)
      pipeRecurse = recursePipeStderr.bind(null, recurse, dispatch, executeFn, registry, targets)
    }
    const [stdout, io, execNode] = await handlePipe(
      pipeRecurse,
      commands,
      stderrFlags,
      session,
      stdin,
      callStack,
    )
    if (!negated) return [stdout, io, execNode]
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    session.errexitImmune = true
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(stream, left, op, right, session, stdin, callStack)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    if (command !== null && command.type === NT.LIST) {
      // tree-sitter hoists a trailing redirect over the whole &&/||
      // list; bash binds it to the last command:
      //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
      // Re-associate and defer target expansion until R runs, so
      // `cd /x && echo hi > f` writes under /x. Compound and subshell
      // bodies keep the whole-body redirect (bash group semantics).
      const [left, op, right] = getListParts(command)
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handleConnection(wrapped, left, op, right, session, stdin, callStack)
    }
    if (command !== null && command.type === NT.PIPELINE) {
      const [commands, stderrFlags] = getPipelineCommands(command)
      const right = commands[commands.length - 1]
      if (right === undefined) throw new Error('redirected pipeline: missing command')
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handlePipe(wrapped, commands, stderrFlags, session, stdin, callStack)
    }
    const [expandedRedirects, pipeNode] = await expandRedirects(
      redirects,
      session,
      executeFn,
      registry,
      callStack,
      sessionView(session, registry.policies),
    )
    let [stdout, io, execNode] = await handleRedirect(
      recurse,
      dispatch,
      command,
      expandedRedirects,
      session,
      stdin,
      callStack,
    )
    if (pipeNode !== null && stdout !== null) {
      const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
      stdout = stdout2
      io = await io.merge(io2)
      execNode = execNode2
    }
    return [stdout, io, execNode]
  }

  if (kind === NodeKind.SUBSHELL) {
    // A subshell is its own shell: background jobs started inside live
    // in a private job table (`$!`/`wait`/`kill` in the body see them;
    // the parent's table never does), mirroring bash's forked process.
    const subTable = new JobTable()
    const subDeps: ExecuteNodeDeps = { ...deps, jobTable: subTable }
    // The opts parameter is load-bearing, not decoration: a job started
    // inside the subshell body hands `handleBackground` its own console
    // and abort signal through it. Dropping it (a 4-parameter closure
    // still satisfies ExecuteNodeFn, since function parameters are
    // bivariant) would run the nested job against the enclosing job's
    // sink and signal instead.
    const subRecurse = (
      n: TSNodeLike,
      s: Session,
      inp: ByteSource | null,
      cs: CallStack | null,
      opts?: ExecuteNodeOpts,
    ): Promise<Result> => executeNode(withOpts(subDeps, opts), n, s, inp, cs)
    return handleSubshell(subRecurse, node.children, session, stdin, callStack, subTable, agentId)
  }

  if (kind === NodeKind.COMPOUND && node.children[0]?.type === NT.ARITH_OPEN) {
    const text = getText(node)
    const expr = await expandArith(
      node,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    let result: ArithResult
    try {
      // Reads resolve against the visible env so a hidden name counts
      // as unset; a hidden write refuses below, in this command's own
      // voice like the readonly refusal.
      result = evaluateArith(expr, visibleEnv(session), 0, sessionElements(session))
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      const errBytes = new TextEncoder().encode(`bash: ((: ${expr}: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    for (const write of result.writes) {
      const name = write.name
      try {
        ensureVarVisible(session, name)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        const errBytes = new TextEncoder().encode(`bash: ${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
      if (session.readonlyVars.has(name)) {
        const errBytes = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
    }
    try {
      for (const write of result.writes) {
        await assignElement(
          session,
          sessionView(session, registry.policies),
          write.name,
          write.key,
          write.value,
        )
      }
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const errBytes = new TextEncoder().encode(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    const code = result.value !== 0n ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: text, exitCode: code }),
    ]
  }

  if (kind === NodeKind.COMPOUND) {
    const allStdout: ByteSource[] = []
    let mergedIo = new IOResult()
    let lastExec = new ExecutionNode({ command: '{}', exitCode: 0 })
    for (const child of node.namedChildren) {
      if (child.type === NT.COMMENT) continue
      const [rawStdout, io, execNode] = await stream(child, session, stdin, callStack)
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session)
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(child.type) &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- recurse() mutates it
        !session.errexitImmune
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    }
    if (allStdout.length === 1 && allStdout[0] !== undefined) {
      return [allStdout[0], mergedIo, lastExec]
    }
    const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
    return [combined, mergedIo, lastExec]
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(stream, branches, elseBody, session, stdin, callStack)
  }

  if (kind === NodeKind.CFOR) {
    const [exprs, body] = getCforParts(node)
    const evalExpr: CforEval = (e, d) =>
      evalCforExpr(e, d, session, executeFn, callStack, sessionView(session, registry.policies))
    return handleCfor(stream, exprs, body, evalExpr, session, stdin, callStack)
  }

  if (kind === NodeKind.FOR || kind === NodeKind.SELECT) {
    const [variable, values, body] = getForParts(node)
    const classified = await expandAndClassify(
      values,
      session,
      executeFn,
      registry,
      session.cwd,
      callStack,
      sessionView(session, registry.policies),
    )
    // The loop word list is consumed by the shell (WordPolicy.SHELL):
    // globs resolve to matches before iteration starts.
    const resolved = await resolveGlobs(
      classified,
      registry,
      session.shellOptions.noglob === true,
      deps.namespace,
    )
    if (kind === NodeKind.SELECT) {
      return handleSelect(
        stream,
        variable,
        resolved,
        body,
        session,
        stdin,
        callStack,
        registry.policies,
      )
    }
    return handleFor(stream, variable, resolved, body, session, stdin, callStack, registry.policies)
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [condition, body] = getWhileParts(node)
    if (kind === NodeKind.UNTIL) {
      return handleUntil(stream, condition, body, session, stdin, callStack)
    }
    return handleWhile(stream, condition, body, session, stdin, callStack)
  }

  if (kind === NodeKind.CASE) {
    const wordNode = getCaseWord(node)
    const word = await expandNode(
      wordNode,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    const items: [string[], TSNodeLike[], string][] = []
    for (const [patternNodes, body, terminator] of getCaseItems(node)) {
      const patterns: string[] = []
      for (const patternNode of patternNodes) {
        patterns.push(
          await expandPattern(
            patternNode,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          ),
        )
      }
      items.push([patterns, body, terminator])
    }
    return handleCase(stream, word, items, session, stdin, callStack)
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    if (session.readonlyFunctions.has(name)) {
      // `readonly -f f` froze the body: either definition syntax refuses
      // with `f: readonly function`, exit 1, and the old body stays,
      // pinned on 5.2.37.
      const err = new TextEncoder().encode(`bash: ${name}: readonly function\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: `function ${name}`, exitCode: 1, stderr: err }),
      ]
    }
    const body = getFunctionBody(node)
    session.functions[name] = body
    return [null, new IOResult(), new ExecutionNode({ command: `function ${name}`, exitCode: 0 })]
  }

  if (kind === NodeKind.DECLARATION) {
    const keyword = getDeclarationKeyword(node)
    const assignments: string[] = []
    // Array literals are staged, not stored: `readonly -a a=(y)` on an
    // already-readonly name has to fail with the old value intact.
    const staged: { name: string; append: boolean; items: string[] }[] = []
    // Option words are kept verbatim, in order, so `--` survives as an
    // end-of-options marker and the handlers can name the *first* bad option
    // letter the way bash does.
    const flagWords: string[] = []
    const flagChars = new Set<string>()
    const plusChars = new Set<string>()
    let optsDone = false
    for (const child of node.namedChildren) {
      if (child.type === NT.VARIABLE_ASSIGNMENT) {
        const valNodes = child.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
        const firstVal = valNodes[0]
        if (firstVal?.type === NT.ARRAY) {
          const text = getText(child)
          const eq = text.indexOf('=')
          const key = eq >= 0 ? text.slice(0, eq) : text
          const append = key.endsWith('+')
          staged.push({
            name: append ? key.slice(0, -1) : key,
            append,
            items: await expandArrayItems(
              firstVal,
              session,
              executeFn,
              registry,
              deps.namespace,
              callStack,
            ),
          })
          continue
        }
        assignments.push(
          await expandNode(
            child,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          ),
        )
      } else if (
        child.type === NT.SIMPLE_EXPANSION ||
        child.type === NT.EXPANSION ||
        child.type === NT.CONCATENATION ||
        child.type === NT.WORD ||
        // A bare `readonly NAME` / `export NAME` operand parses as a
        // variable_name, not a word, and a quoted assignment
        // (`export 'FOO=bar'`) as a plain string operand.
        child.type === NT.VARIABLE_NAME ||
        child.type === NT.STRING ||
        child.type === NT.RAW_STRING ||
        child.type === NT.ANSI_C_STRING ||
        child.type === NT.TRANSLATED_STRING
      ) {
        const expanded = await expandNode(
          child,
          session,
          executeFn,
          callStack,
          sessionView(session, registry.policies),
        )
        // An *unquoted* expansion that came back empty is removed by
        // word splitting, so `export $UNSET` is a bare `export` and
        // prints the listing. A quoted one is a real, empty operand:
        // GNU answers both `export ""` and `export "$UNSET"` with
        // ``export: `': not a valid identifier``, so it has to reach
        // the builtin rather than vanish here.
        if (expanded === '' && (child.type === NT.SIMPLE_EXPANSION || child.type === NT.EXPANSION))
          continue
        if (!optsDone && expanded.startsWith('-') && expanded.length > 1) {
          flagWords.push(expanded)
          if (expanded === '--') optsDone = true
          else for (const ch of expanded.slice(1)) flagChars.add(ch)
        } else if (
          !optsDone &&
          expanded.startsWith('+') &&
          expanded.length > 1 &&
          (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
        ) {
          // `+attr` turns an attribute off. Only the declare family
          // reads it: `export +x` and `readonly +r` are `not a valid
          // identifier` in GNU, so for those two the word falls through
          // as an operand and refuses there.
          for (const ch of expanded.slice(1)) plusChars.add(ch)
        } else {
          assignments.push(expanded)
        }
      }
    }
    const cmdWord = keyword === NT.LOCAL ? 'local' : keyword
    if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
      const refused = declareOptionRefusal(cmdWord, flagChars, plusChars)
      if (refused !== null) return refused
    }
    if (
      (flagChars.has('f') || flagChars.has('F')) &&
      (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
    ) {
      // `-f`/`-F` select functions, not variables: `-rf` freezes, `-f
      // NAME` prints the body, `-F NAME` prints the name, and a missing
      // name is exit 1 without a word.
      return handleDeclareFunctions(cmdWord, session, flagChars, assignments)
    }
    const isReadonly = keyword === 'readonly' || flagChars.has('r')
    // `-l` and `-u` cannot both hold; a cluster naming both sets neither
    // (pinned: `declare -lu s=aBc` prints `declare -- s`).
    let shaping = new Set(attrsFor('ilu', (c) => flagChars.has(c) && !plusChars.has(c)))
    if (shaping.has(VarAttr.Lower) && shaping.has(VarAttr.Upper)) {
      shaping = new Set([...shaping].filter((a) => a !== VarAttr.Lower && a !== VarAttr.Upper))
    }
    const conversionErrors: string[] = []
    if (flagChars.has('A') || flagChars.has('a')) {
      // `declare -a NAME` / `declare -A NAME` with no value declare an
      // empty array of that kind, so ${#NAME[@]} is 0 and an element
      // write leaves the other slots unassigned. GNU refuses to
      // convert between the two kinds and says so per name while the
      // rest of the operands still declare.
      const wantAssoc = flagChars.has('A')
      for (const bare of assignments) {
        if (bare.includes('=')) continue
        // Both branches below write array storage raw (the top-level
        // one migrates an existing scalar), so a hidden name refuses
        // like any assignment spelling before either lands.
        try {
          ensureVarVisible(session, bare)
        } catch (err) {
          if (!(err instanceof PolicyDenied)) throw err
          throw new ExitSignal(1, new TextEncoder().encode(`${err.message}\n`), null, 1)
        }
        if (wantAssoc && Object.hasOwn(session.arrays, bare)) {
          conversionErrors.push(
            `bash: ${cmdWord}: ${bare}: cannot convert indexed to associative array`,
          )
          continue
        }
        if (!wantAssoc && Object.hasOwn(session.assocs, bare)) {
          conversionErrors.push(
            `bash: ${cmdWord}: ${bare}: cannot convert associative to indexed array`,
          )
          continue
        }
        if (noteLocalArray(session, bare)) {
          // Inside a function this shadows whatever the caller had with
          // a fresh empty array of the declared kind.
          seedVar(session, bare, wantAssoc ? {} : [])
        } else if (wantAssoc && !Object.hasOwn(session.assocs, bare)) {
          // At top level an existing scalar becomes the value at the
          // literal key "0" (GNU allows scalar-to-associative
          // conversion, unlike indexed).
          const scalar = session.env[bare]
          seedVar(session, bare, scalar === undefined ? {} : { '0': scalar })
        } else if (!wantAssoc && !Object.hasOwn(session.arrays, bare)) {
          // At top level an existing scalar becomes element 0.
          const scalar = session.env[bare]
          seedVar(session, bare, scalar === undefined ? [] : [scalar])
        }
      }
    }
    // Array literals travel as data: the handler stores them through
    // the session door and owns both refusal voices, so the executor
    // only expands and stages.
    if (isReadonly) {
      // Only the `readonly` keyword owns -p / illegal-option handling;
      // `declare -r` keeps names only.
      const declView = sessionView(session, registry.policies)
      const stored: string[] = []
      const result =
        keyword === 'readonly'
          ? await handleReadonly(
              [...flagWords, ...assignments],
              session,
              declView,
              staged,
              stored,
              flagChars.has('A'),
              shaping,
            )
          : await handleReadonly(
              assignments,
              session,
              declView,
              staged,
              stored,
              flagChars.has('A'),
              shaping,
            )
      // `declare -rx X=1` carries both attributes: GNU prints
      // `declare -rx X="1"`. Readonly answers first, so the export stamp
      // has to land here too, or `-r` silently ate the `-x`.
      const refused = await stampAttrs(
        session,
        declView,
        flagChars,
        plusChars,
        assignments,
        staged,
        stored,
      )
      return refused ?? mergeConversionErrors(result, conversionErrors)
    }
    // declare/typeset scope like `local` inside a function (bash
    // semantics) and assign globally at top level, which is exactly
    // handleLocal's fallback when no function scope is active.
    if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
      // `-p` prints rather than declares, so it is answered before the
      // assignment path runs at all.
      if (
        (flagChars.has('p') || plusChars.has('p')) &&
        (keyword === 'declare' || keyword === 'typeset')
      ) {
        return handleDeclarePrint(assignments, session)
      }
      const declView2 = sessionView(session, registry.policies)
      const stored2: string[] = []
      const result = await handleLocal(
        assignments,
        session,
        declView2,
        staged,
        // `declare`/`typeset` share this handler but have to name
        // themselves in a diagnostic rather than say `local`.
        cmdWord,
        stored2,
        flagChars.has('A'),
        shaping,
      )
      const plusRefused = plusRefusals(cmdWord, session, declView2, plusChars, assignments, staged)
      if (plusRefused !== null) return plusRefused
      const refused2 = await stampAttrs(
        session,
        declView2,
        flagChars,
        plusChars,
        assignments,
        staged,
        stored2,
      )
      return refused2 ?? mergeConversionErrors(result, conversionErrors)
    }
    // Pass export flags through so -p / bare print and illegal options work.
    const exportResult = await handleExport(
      [...flagWords, ...assignments],
      session,
      sessionView(session, registry.policies),
      staged,
    )
    return mergeConversionErrors(exportResult, conversionErrors)
  }

  if (kind === NodeKind.UNSET) {
    return handleUnset(getUnsetArgs(node), session, sessionView(session, registry.policies))
  }

  if (kind === NodeKind.TEST) {
    const opener = node.children[0]?.type ?? '['
    if (opener === '[[') {
      const tree = await expandDoubleBracket(
        node,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
      return handleTest(dispatch, deps.namespace, tree, session, '[[')
    }
    const expanded = await expandTestExpr(
      node,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    return handleTest(dispatch, deps.namespace, expanded, session, '[')
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    const [rawStdout, io, execNode] = await stream(inner, session, stdin, callStack)
    // Lazy exit codes (exitOnEmpty in grep) must be final before
    // inverting, or `! grep miss f` negates the provisional 0.
    const stdout = await applyBarrier(rawStdout, io, BarrierPolicy.VALUE)
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    session.errexitImmune = true
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.VAR_ASSIGN) {
    const text = getText(node)
    if (!text.includes('=')) {
      return [null, new IOResult(), new ExecutionNode({ command: text, exitCode: 0 })]
    }
    const subSeq = session.cmdsubSeq
    const subscriptNode = node.namedChildren.find((c) => c.type === 'subscript') ?? null
    const nameSource = subscriptNode ?? node
    const nameNode = nameSource.namedChildren.find((c) => c.type === NT.VARIABLE_NAME)
    const eq = text.indexOf('=')
    const key = nameNode !== undefined ? nameNode.text : text.slice(0, eq)
    const append = node.children.some((c) => c.type === '+=')
    if (session.readonlyVars.has(key)) {
      // A bare assignment to a readonly variable is a fatal
      // variable-assignment error in non-interactive bash: the rest of
      // the line is abandoned (builtins like `export` merely fail with
      // 1 and continue).
      const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
      throw new ExitSignal(1, err, null, 1)
    }
    const valNodes = node.namedChildren.filter(
      (c) => c.type !== NT.VARIABLE_NAME && c.type !== 'subscript',
    )
    // Every branch below computes its resulting value with bash's own
    // mechanics on a copy, then stores through the one session door,
    // which owns the gate and the scalar/array invariant.
    const view = sessionView(session, registry.policies)
    const firstVal = valNodes[0]
    if (firstVal?.type === NT.ARRAY) {
      const items = await expandArrayItems(
        firstVal,
        session,
        executeFn,
        registry,
        deps.namespace,
        callStack,
      )
      const heldMap = session.assocs[key]
      if (heldMap !== undefined) {
        const { map, badWords } = buildAssocLiteral(heldMap, items, append)
        await assignVar(view, key, map)
        if (badWords.length > 0) {
          const errBytes = new TextEncoder().encode(
            badWords
              .map(
                (word) =>
                  `bash: ${key}: '${word}': must use subscript when assigning associative array`,
              )
              .join('\n') + '\n',
          )
          return [
            null,
            new IOResult({ exitCode: 1, stderr: errBytes }),
            new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
          ]
        }
        const mapCode = assignmentStatus(session, subSeq)
        return [
          null,
          new IOResult({ exitCode: mapCode }),
          new ExecutionNode({ command: text, exitCode: mapCode }),
        ]
      }
      let held: ShellArray | null = session.arrays[key] ?? null
      if (append && held === null) {
        const scalar = session.env[key]
        held = scalar === undefined ? null : [scalar]
      }
      // `arr+=(...)` starts at the extent, so it fills the hole a
      // trailing `unset arr[last]` left but skips interior ones; a
      // `[i]=v` element places at i and the next plain word continues
      // from there.
      const base = buildIndexedLiteral(held, items, append, (sub) =>
        elementIndex(sub, visibleEnv(session), sessionElements(session)),
      )
      await assignVar(view, key, base)
      const arrCode = assignmentStatus(session, subSeq)
      return [
        null,
        new IOResult({ exitCode: arrCode }),
        new ExecutionNode({ command: text, exitCode: arrCode }),
      ]
    }
    let val = text.slice(eq + 1)
    if (firstVal !== undefined) {
      val = await expandNode(
        firstVal,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
    }
    if (subscriptNode !== null) {
      const subText = await subscriptKeyText(
        subscriptNode,
        key,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
      const heldMap = session.assocs[key]
      const rawSub = subscriptNode.text.slice(key.length + 1, -1)
      if (rawSub.trim() === '' || (heldMap !== undefined && subText === '')) {
        // bash aborts the whole line on a bad assignment subscript
        // (status 1), naming the raw spelling (`m[$e]: bad array
        // subscript`). An indexed subscript that merely *expands*
        // empty stays legal (arithmetic on nothing is 0), so only the
        // associative kind checks the expanded text.
        const nameText = text.slice(0, eq).replace(/\+$/, '')
        throw new ExitSignal(
          1,
          new TextEncoder().encode(`bash: ${nameText}: bad array subscript\n`),
          null,
          1,
        )
      }
      if (heldMap !== undefined) {
        // The subscript is the key: no arithmetic, `m[1+1]` writes the
        // key "1+1".
        const newMap = { ...heldMap }
        newMap[subText] = append ? (heldMap[subText] ?? '') + val : val
        await assignVar(view, key, newMap)
        const mapCode = assignmentStatus(session, subSeq)
        return [
          null,
          new IOResult({ exitCode: mapCode }),
          new ExecutionNode({ command: text, exitCode: mapCode }),
        ]
      }
      const existing = session.arrays[key]
      let arr: ShellArray
      if (existing === undefined) {
        const scalar = session.env[key]
        arr = scalar === undefined ? [] : [scalar]
      } else {
        arr = [...existing]
      }
      let idx = arrayIndex(subText, visibleEnv(session), sessionElements(session))
      if (idx < 0) idx += arrayExtent(arr)
      if (idx < 0) {
        // Same fatal shape as the empty subscript above.
        const nameText = text.slice(0, eq).replace(/\+$/, '')
        throw new ExitSignal(
          1,
          new TextEncoder().encode(`bash: ${nameText}: bad array subscript\n`),
          null,
          1,
        )
      }
      arraySet(arr, idx, append ? arrayGet(arr, idx) + val : val)
      await assignVar(view, key, arr)
      const subCode = assignmentStatus(session, subSeq)
      return [
        null,
        new IOResult({ exitCode: subCode }),
        new ExecutionNode({ command: text, exitCode: subCode }),
      ]
    }
    const heldMap = session.assocs[key]
    const heldArr = session.arrays[key]
    if (heldMap !== undefined) {
      // `m=x` on an associative array writes the literal key "0" and
      // keeps every other key, as bash does.
      const newMap = { ...heldMap }
      newMap['0'] = append ? (heldMap['0'] ?? '') + val : val
      await assignVar(view, key, newMap)
    } else if (heldArr !== undefined) {
      // `a=x` writes element 0 and keeps the rest; `a+=x` appends onto
      // element 0.
      const newArr = [...heldArr]
      arraySet(newArr, 0, append ? arrayGet(newArr, 0) + val : val)
      await assignVar(view, key, newArr)
    } else {
      const heldVar = session.vars[key]
      let newVal: string
      if (append && heldVar?.attrs.has(VarAttr.Integer) === true) {
        // `n+=3` on an integer name adds: the door evaluates `old + new`,
        // so `declare -i n=5; n+=3` stores 8, not 53.
        newVal = `${session.env[key] ?? '0'} + (${val})`
      } else {
        newVal = append ? (session.env[key] ?? '') + val : val
      }
      await assignVar(view, key, newVal)
    }
    // Reassigning OPTIND (even to its current value) restarts the getopts
    // scan, matching bash's internal char pointer.
    if (key === 'OPTIND') session.getoptsOptind = null
    const code = assignmentStatus(session, subSeq)
    const assignIo = new IOResult({ exitCode: code })
    if (session.shellOptions.xtrace === true) {
      assignIo.stderr = traceAssignment(key, val, append)
    }
    return [null, assignIo, new ExecutionNode({ command: text, exitCode: code })]
  }

  // Assignment-only statement (a=1 b=2).
  if (kind === NodeKind.VAR_ASSIGNS) {
    const subSeq = session.cmdsubSeq
    let mergedIo = new IOResult()
    for (const child of node.namedChildren) {
      if (child.type !== NT.VARIABLE_ASSIGNMENT) continue
      const [, io] = await recurse(child, session, stdin, callStack)
      mergedIo = await mergedIo.merge(io)
    }
    // The statement's status follows the last command substitution
    // performed across ALL its assignments, not the last child's.
    const code = assignmentStatus(session, subSeq)
    mergedIo.exitCode = code
    return [null, mergedIo, new ExecutionNode({ command: getText(node), exitCode: code })]
  }

  // Constructs the parser accepts but the executor cannot honor (e.g.
  // C-style `for ((;;))`). Mirrors the unsupported-builtin diagnostic
  // so agents see a capability gap, not a crash.
  const unsupportedErr = new TextEncoder().encode(
    `mirage: unsupported shell construct: ${node.type}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: unsupportedErr }),
    new ExecutionNode({ command: node.text, exitCode: 2, stderr: unsupportedErr }),
  ]
}
