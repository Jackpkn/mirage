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

import type { ShellVar } from '../../shell/variable.ts'
import { sessionEntry, setSessionEntry } from '../session/session.ts'
import { seedVar, setAttr } from '../session/state.ts'
import { VarAttr } from '../../shell/variable.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { PolicyDecision } from '../../runtime/policy/index.ts'
import { mergeSignals } from '../abort.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  ProcessSubDirection,
  getCommandName,
  getParts,
  getProcessSubBody,
  getProcessSubDirection,
  getText,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { NodeType as NT, ShellBuiltin as SB } from '../../shell/types.ts'
import { PathSpec, wordText } from '../../types.ts'
import { classifyBarePath } from '../expand/classify/index.ts'
import { Argv, expandArgv } from '../expand/argv.ts'
import { expandBoundaryGlobs } from '../expand/globs.ts'
import { type ExecuteFn, expandNode } from '../expand/node.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { handleCommand } from '../executor/command.ts'
import { pathFlagScopes, positionalScopes } from '../executor/command/routing.ts'
import { toScope } from '../executor/builtins/scope.ts'
import {
  type AliasMark,
  aliasCommandText,
  handleAlias,
  handleUnalias,
} from '../executor/builtins/alias.ts'
import { handleExecCommand } from '../executor/builtins/exec_cmd.ts'
import { findSyntaxError } from '../../shell/parse.ts'
import { resolvePath } from '../../utils/path.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { PolicyDenied, resolveLimit } from '../../policy/index.ts'
import { BreakSignal, ContinueSignal } from '../executor/control.ts'
import { traceCommand } from '../../shell/xtrace.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import {
  acceptsLine,
  followPaths,
  handleBash,
  handleExecPath,
  handleCd,
  handleCommandBuiltin,
  handleType,
  handleWhich,
  handleEcho,
  handleEnv,
  handleEval,
  handleExport,
  handleHistory,
  handleChgrp,
  handleDf,
  handleChmod,
  handleChown,
  handleLet,
  handleLn,
  handleLocal,
  handleMan,
  handleMapfile,
  handlePrintenv,
  handlePrintf,
  handleRead,
  handleReadlink,
  handleTouch,
  handleExit,
  handleGetopts,
  handleReturn,
  handleSet,
  handleShift,
  handleShopt,
  handleSleep,
  handleSource,
  handleTest,
  handleTimeout,
  handleTrap,
  handleUmask,
  handleUnset,
  handleWhoami,
  handleXargs,
  linkFlags,
  prepareMv,
  stripLinkOperands,
} from '../executor/builtins/index.ts'
import { globPattern } from '../../utils/glob_walk.ts'
import { CycleError } from '../../utils/path.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { SLASH_KEEPS_LAST, UNSUPPORTED_BUILTINS, followsLastComponent } from '../route/index.ts'
import type { Session } from '../session/session.ts'
import { homeDir, logicalCwd } from '../session/shell_dirs.ts'
import { ensureVarVisible, sessionView } from '../session/state.ts'
import { preSessionGate } from '../../policy/index.ts'
import { ExecutionNode } from '../types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

// Parse the optional numeric level of `break`/`continue`.
function loopLevels(args: readonly string[]): number {
  const first = args[0]
  if (first !== undefined && /^\d+$/.test(first) && parseInt(first, 10) > 0) {
    return parseInt(first, 10)
  }
  return 1
}

// Split leading -L/-P option flags (clusters like -LP, and a `--`
// terminator) from the operands. Shared by `cd` (which also takes -e -@)
// and `pwd`, so the last-wins rule -- `pwd -L -P` is physical, `pwd -P
// -L` logical -- has one implementation. A bare `-` is an operand (`cd`'s
// OLDPWD shorthand), not an option. `bad` is the first unknown character.
function splitModeOptions(
  args: (string | PathSpec)[],
  letters = 'LPe@',
  // The mode to assume when the line names neither, which is what
  // `set -P` changes for the whole session.
  fallback = false,
): {
  operands: (string | PathSpec)[]
  bad: string | null
  physical: boolean
} {
  const operands: (string | PathSpec)[] = []
  let parsing = true
  let physical = fallback
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.virtual : arg
    if (parsing) {
      if (s === '--') {
        parsing = false
        continue
      }
      if (s !== '-' && s.length >= 2 && s.startsWith('-')) {
        let bad: string | null = null
        for (const c of s.slice(1)) {
          if (!letters.includes(c)) {
            bad = c
            break
          }
        }
        if (bad !== null) return { operands, bad, physical }
        for (const c of s.slice(1)) {
          if (c === 'P') physical = true
          else if (c === 'L') physical = false
        }
        continue
      }
      parsing = false
    }
    operands.push(arg)
  }
  return { operands, bad: null, physical }
}

export async function executeCommand(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  session: Session,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: PolicyDecision,
  signal?: AbortSignal,
  // Parse one line into a tree; only alias expansion needs it. Absent
  // means an alias is stored and printed but never expanded.
  reparse?: (line: string) => TSNodeLike,
): Promise<Result> {
  const name = getCommandName(node)
  const [assignmentNodes, nonPrefixParts] = splitEnvPrefix(getParts(node))

  // bash rewrites the head word of a simple command before any other
  // expansion, textually, and reads the result as a fresh line: an alias
  // holding a pipe is a pipe. Only an unquoted plain word qualifies, and
  // `aliasValue` applies the rest of bash's rules (expand_aliases, the
  // same-line mark, the no-second-expansion stack). The rewritten line
  // runs through the same executor with the same call stack, so `$1`
  // inside a function still means the function's argument.
  const headNode = nonPrefixParts[0]
  if (
    reparse !== undefined &&
    Object.keys(session.aliases).length > 0 &&
    headNode?.type === NT.COMMAND_NAME &&
    headNode.namedChildren[0]?.type === NT.WORD
  ) {
    const head = getText(headNode)
    const mark: AliasMark = [session.parseCurrent, node.startPosition?.row ?? 0]
    const source = getText(node)
    const base = node.startIndex ?? 0
    const rest = source.slice((headNode.endIndex ?? 0) - base)
    const rewritten = aliasCommandText(session, head, rest, mark)
    if (rewritten !== null) {
      const line = source.slice(0, (headNode.startIndex ?? 0) - base) + rewritten
      const ast = reparse(line)
      const offending = findSyntaxError(ast as Parameters<typeof findSyntaxError>[0])
      if (offending !== null) {
        const snippet = offending.trim()
        const errBytes = new TextEncoder().encode(
          snippet.length > 0
            ? `mirage: syntax error near '${snippet}'\n`
            : 'mirage: syntax error in command\n',
        )
        return [
          null,
          new IOResult({ exitCode: 2, stderr: errBytes }),
          new ExecutionNode({ command: head, exitCode: 2, stderr: errBytes }),
        ]
      }
      session.aliasStack.push(head)
      try {
        return await recurse(ast, session, stdinIn, callStack)
      } finally {
        session.aliasStack.pop()
      }
    }
  }

  const prefixAssignments: [string, string][] = []
  for (const p of assignmentNodes) {
    const atext = getText(p)
    const eq = atext.indexOf('=')
    if (eq < 0) continue
    const key = atext.slice(0, eq)
    const rawVal = atext.slice(eq + 1)
    const valNodes = p.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
    const firstVal = valNodes[0]
    const v =
      firstVal !== undefined
        ? await expandNode(
            firstVal,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          )
        : rawVal
    prefixAssignments.push([key, v])
  }

  for (const [k, v] of prefixAssignments) {
    // The hidden gate runs first, as in setVar: calling a hidden name
    // "readonly" would leak that it exists. Both branches below write
    // session.env raw (a function-call prefix on purpose never
    // restores), so ungated they would let a narrowed session clobber
    // the host's value.
    try {
      ensureVarVisible(session, k)
      // ...and `preSession` right after, with the value, because a
      // prefix assignment is a session write like any other and the form
      // exports it for the command. Only the hidden half was checked
      // here, so a deployment refusing `SECRET_*` still saw
      // `SECRET_K=leak printenv SECRET_K` print the secret: the seeding
      // below goes through `seedVar`, which is the ungated door, so this
      // loop is the only place the rule can be asked.
      await preSessionGate(registry.policies, {
        plane: 'env',
        verb: 'set',
        key: k,
        value: v,
        sessionId: session.sessionId,
      })
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const stderr = new TextEncoder().encode(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr }),
        new ExecutionNode({ command: name !== '' ? name : k, exitCode: 1, stderr }),
      ]
    }
    if (session.readonlyVars.has(k)) {
      const err = new TextEncoder().encode(`bash: ${k}: readonly variable\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: name !== '' ? name : k, exitCode: 1, stderr: err }),
      ]
    }
  }

  if (prefixAssignments.length > 0 && name === '') {
    for (const [k, v] of prefixAssignments) seedVar(session, k, v)
    const cmdLabel = prefixAssignments.map(([k, v]) => `${k}=${v}`).join(' ')
    return [null, new IOResult(), new ExecutionNode({ command: cmdLabel, exitCode: 0 })]
  }

  const isFunctionCall = name !== '' && session.functions[name] !== undefined
  const savedEnvOverrides = new Map<string, ShellVar | null>()
  for (const [k, v] of prefixAssignments) {
    if (!isFunctionCall) savedEnvOverrides.set(k, sessionEntry(session.vars, k) ?? null)
    // Exported for the duration, which is the whole point of the form:
    // `TOKEN=x printenv TOKEN` prints `x` because bash puts a prefix
    // assignment in the *command's environment*, not merely in the
    // shell. Seeding it plain left it invisible to every reader of
    // `envSnapshot` — the command's own env, an installed CLI, a guest
    // runtime — once that view narrowed to the exported set. The saved
    // record is put back below, so the attribute does not outlive the
    // command; a function call deliberately saves nothing and keeps the
    // assignment, as bash does.
    seedVar(session, k, v)
    setAttr(session, k, VarAttr.Export)
  }

  try {
    return await runCommandBody(
      recurse,
      dispatch,
      registry,
      namespace,
      executeFn,
      node,
      nonPrefixParts,
      name,
      session,
      stdinIn,
      callStack,
      jobTable,
      ensureOpen,
      runtimeBindings,
      routingDecision,
      signal,
    )
  } finally {
    for (const [k, prev] of savedEnvOverrides) {
      if (prev === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.vars[k]
      } else {
        setSessionEntry(session.vars, k, prev)
      }
    }
  }
}

async function runCommandBody(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  parts: TSNodeLike[],
  name: string,
  session: Session,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: PolicyDecision,
  signalIn?: AbortSignal,
): Promise<Result> {
  let stdin = stdinIn
  // A background job's kill channel rides the session; fold it in so
  // builtins (sleep) and the mount layer observe the kill.
  const signal = mergeSignals(signalIn, session.abortSignal)

  if (node.parent?.type !== NT.REDIRECTED_STATEMENT) {
    for (const child of node.namedChildren) {
      if (child.type === NT.HERESTRING_REDIRECT) {
        for (const sc of child.namedChildren) {
          const content = await expandNode(
            sc,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          )
          stdin = encodeText(`${content}\n`)
          break
        }
      }
    }
  }

  const procSubParts: Uint8Array[] = []
  const procSubStderr: Uint8Array[] = []
  const cleanParts: TSNodeLike[] = []
  for (const p of parts) {
    if (p.type === NT.PROCESS_SUBSTITUTION) {
      if (getProcessSubDirection(p) === ProcessSubDirection.OUTPUT) {
        const err = new TextEncoder().encode('mirage: unsupported: process substitution >(...)\n')
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({
            command: name === '' ? 'process_sub' : name,
            exitCode: 2,
            stderr: err,
          }),
        ]
      }
      const inner = getProcessSubBody(p)
      if (inner !== '') {
        const io = await executeFn(inner, { sessionId: session.sessionId })
        procSubParts.push(await materialize(io.stdout))
        const stderr = await materialize(io.stderr)
        if (stderr.byteLength > 0) procSubStderr.push(stderr)
      }
      continue
    }
    cleanParts.push(p)
  }
  if (procSubParts.length > 0 && stdin === null) {
    let total = 0
    for (const c of procSubParts) total += c.byteLength
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of procSubParts) {
      merged.set(c, off)
      off += c.byteLength
    }
    stdin = merged
  }

  const argv = await expandArgv(
    cleanParts,
    session,
    executeFn,
    callStack,
    registry,
    namespace,
    sessionView(session, registry.policies),
  )

  // Limits resolve against the expanded name, so `$CMD`-style
  // invocations get their real command's policy.
  const resolved = argv.name !== '' ? resolveLimit(argv.name) : null
  const timeout = resolved !== null ? resolved.timeoutSeconds : null
  // Capture xtrace before the body runs so `set -x` itself is not
  // traced (bash enables tracing only for the following commands).
  const xtrace = session.shellOptions.xtrace === true
  const [stdout, io, execNode] = await runWithTimeout(
    runArgv(
      recurse,
      dispatch,
      registry,
      namespace,
      executeFn,
      argv,
      session,
      stdin,
      callStack,
      jobTable,
      ensureOpen,
      runtimeBindings,
      routingDecision,
      signal,
      node.startPosition?.row ?? 0,
    ),
    timeout,
    argv.name !== '' ? argv.name : '?',
  )
  if (io.producer === null && argv.name !== '') {
    // Builtins and other non-mount routes return no rider; stamp the
    // expanded name here so postExecute policies keyed on a command
    // (echo, printf, ...) still see it.
    io.producer = { command: argv.name, prefixes: [], declared: null }
  }
  if (procSubStderr.length > 0) {
    const stderr = await materialize(io.stderr)
    io.stderr = concatBytes([...procSubStderr, stderr])
    execNode.stderr = io.stderr
  }
  if (xtrace && argv.name !== '') {
    const existing = await materialize(io.stderr)
    io.stderr = concatBytes([traceCommand([argv.name, ...argv.args]), existing])
  }
  return [stdout, io, execNode]
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function runArgv(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  argv: Argv,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: PolicyDecision,
  signal?: AbortSignal,
  // The command's line within its parse, which only `alias` reads: a
  // definition remembers where it was made so a use on the same line
  // does not see it, as bash's line reader would not.
  row = 0,
): Promise<Result> {
  const name = argv.name

  // A glob whose directory holds a child mount cannot be pushed down to
  // one backend: the mount root is a child of that directory but its keys
  // live in another resource, so the backend reports "no such file" for a
  // name its own listing shows. Expanding such a word here lets the
  // matches route per mount. It has to happen before the admission
  // policies below, not just before the follow policy: a word left
  // unexpanded reaches preCommand as the literal pattern, and
  // MountRootPolicy cannot recognize a mount root inside one, so
  // `tar -cf out.tar /base/*` would archive a whole backend the same
  // operand typed by hand is refused for.
  const boundary = await expandBoundaryGlobs(argv.operands, registry, namespace)
  const expandedWords = boundary.map(wordText)
  // Compared as words, not as a count: a glob that matches exactly one
  // name (`du /base/i*` where only the mount root matches) is still an
  // expansion, and dropping it routes the pattern to a backend that
  // cannot serve the child mount's keys.
  const typedWords = argv.operands.map(wordText)
  if (
    expandedWords.length !== typedWords.length ||
    expandedWords.some((w, i) => w !== typedWords[i])
  ) {
    argv = new Argv(argv.name, expandedWords, boundary)
  }

  const args = [...argv.args]
  let operands = [...argv.operands]

  // Admission policies. The one chokepoint every command class passes
  // through: shell builtins, namespace-routed commands (touch/chmod/
  // ln -s), job builtins, shell functions, and mount commands all
  // route below, so the hook must fire here, not in handleCommand.
  // Paths are the operands as typed plus path-valued flags (shuf -o
  // DEST); refusals win over flag parsing, routing, and runtime
  // placement.
  if (name !== '') {
    const scopes: PathSpec[] = []
    for (const p of operands) {
      if (p instanceof PathSpec) scopes.push(p)
    }
    scopes.push(...pathFlagScopes(name, args, session.cwd))
    if (name.includes('/')) {
      // A slash-carrying head word is a file the line executes (the
      // path-execution branch below), and it lives in argv[0], not the
      // operands, so a path-pattern guard would never see it without
      // this row.
      scopes.unshift(toScope(resolvePath(name, session.cwd)))
    }
    const deny = await registry.policies.preCommand({
      command: name,
      paths: scopes,
      operands: positionalScopes(name, args, session.cwd, operands),
      argv: args,
      cwd: session.cwd,
      registry,
    })
    if (deny !== null) {
      const err = new TextEncoder().encode(deny.message)
      const exitCode = deny.exitCode ?? 1
      return [
        null,
        new IOResult({ exitCode, stderr: err }),
        new ExecutionNode({
          command: [name, ...args].join(' '),
          stderr: err,
          exitCode,
        }),
      ]
    }
  }

  // Path execution: bash hands a slash-carrying head word to the
  // loader, never to command lookup: no builtin, function, or CLI can
  // claim it. After the admission gate so a policy sees the line like
  // any other.
  if (name.includes('/')) {
    return handleExecPath(dispatch, executeFn, name, args, session, stdin)
  }

  // Unsupported bash builtins. Constructs the parser accepts but the
  // executor cannot honor. Returning a clear error lets LLMs detect a
  // capability gap instead of treating it as a missing binary.
  if (UNSUPPORTED_BUILTINS.has(name)) {
    const err = new TextEncoder().encode(`mirage: unsupported builtin: ${name}\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: name, exitCode: 2, stderr: err }),
    ]
  }

  // Shell builtins
  // `set -P` (`set -o physical`) is the session-wide version of the
  // per-command flag, and GNU applies it to both `cd` and `pwd`.
  const shellPhysical = session.shellOptions.physical === true

  if (name === SB.PWD) {
    const { bad: pwdBad, physical: pwdPhysical } = splitModeOptions(operands, 'LP', shellPhysical)
    if (pwdBad !== null) {
      const err = new TextEncoder().encode(
        `pwd: -${pwdBad}: invalid option\npwd: usage: pwd [-LP]\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'pwd', exitCode: 2, stderr: err }),
      ]
    }
    // GNU ignores operands entirely: `pwd extra` still prints the cwd.
    const cwd = pwdPhysical ? session.cwd : logicalCwd(session)
    const out = new TextEncoder().encode(`${cwd}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'pwd', exitCode: 0 })]
  }

  if (name === SB.CD) {
    const {
      operands: cdOperands,
      bad,
      physical,
    } = splitModeOptions(operands, 'LPe@', shellPhysical)
    const links = namespace.symlinkTargets()
    if (bad !== null) {
      const err = new TextEncoder().encode(
        `cd: -${bad}: invalid option\ncd: usage: cd [-L|[-P [-e]] [-@]] [dir]\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'cd', exitCode: 2, stderr: err }),
      ]
    }
    if (cdOperands.length > 1) {
      const err = new TextEncoder().encode('cd: too many arguments\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'cd', exitCode: 1, stderr: err }),
      ]
    }
    if (cdOperands.length === 0) {
      const home = homeDir(session)
      if (home === null) {
        const err = new TextEncoder().encode('cd: HOME not set\n')
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'cd', exitCode: 1, stderr: err }),
        ]
      }
      return handleCd(
        dispatch,
        (p) => registry.isMountRoot(p),
        home,
        session,
        false,
        null,
        links,
        physical,
      )
    }
    const raw = cdOperands[0]
    const rawStr = raw instanceof PathSpec ? raw.virtual : String(raw)
    if (rawStr === '-') {
      const old = session.env.OLDPWD
      if (!old) {
        const err = new TextEncoder().encode('cd: OLDPWD not set\n')
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'cd -', exitCode: 1, stderr: err }),
        ]
      }
      return handleCd(
        dispatch,
        (p) => registry.isMountRoot(p),
        old,
        session,
        true,
        null,
        links,
        physical,
      )
    }
    let path: string | PathSpec
    let cdpathTarget: string
    if (raw instanceof PathSpec) {
      path = raw
      cdpathTarget = raw.rawPath
    } else if (rawStr.startsWith('/')) {
      path = rawStr
      cdpathTarget = rawStr
    } else {
      path = classifyBarePath(rawStr, registry, session.cwd)
      cdpathTarget = rawStr
    }
    return handleCd(
      dispatch,
      (p) => registry.isMountRoot(p),
      path,
      session,
      false,
      cdpathTarget,
      links,
      physical,
    )
  }

  if (name === SB.TRUE) {
    return [null, new IOResult(), new ExecutionNode({ command: 'true', exitCode: 0 })]
  }

  if (name === SB.COLON) {
    return [null, new IOResult(), new ExecutionNode({ command: ':', exitCode: 0 })]
  }

  if (name === SB.FALSE) {
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'false', exitCode: 1 }),
    ]
  }

  if (name === SB.EVAL) return handleEval(executeFn, args, session)
  if (name === SB.BASH || name === SB.SH) {
    return handleBash(dispatch, executeFn, args, session, stdin, name)
  }
  if (name === SB.EXPORT)
    return handleExport(args, session, sessionView(session, registry.policies))
  if (name === SB.UNSET) return handleUnset(args, session, sessionView(session, registry.policies))
  if (name === SB.LOCAL) return handleLocal(args, session, sessionView(session, registry.policies))
  if (name === SB.PRINTENV) {
    return handlePrintenv(args.length > 0 ? (args[0] ?? null) : null, session)
  }
  if (name === SB.ENV) return handleEnv(executeFn, args, session, stdin)
  if (name === SB.WHOAMI) return handleWhoami(namespace)
  if (name === SB.MAN) return handleMan(args, session, registry)
  if (name === SB.HISTORY) return handleHistory(registry, args, session)
  if (name === SB.SET) return handleSet(args, session, callStack)
  if (name === SB.SHIFT) {
    return handleShift(args, callStack, session)
  }
  if (name === SB.GETOPTS) {
    return handleGetopts(args, session, callStack, sessionView(session, registry.policies))
  }
  if (name === SB.TRAP) return handleTrap(session)
  if (name === SB.LET) {
    return handleLet(args, session, sessionView(session, registry.policies))
  }
  if (name === SB.UMASK) return handleUmask(args, session)
  if (name === SB.SHOPT) return handleShopt(args, session)
  if (name === SB.ALIAS) return handleAlias(args, session, [session.parseCurrent, row])
  if (name === SB.UNALIAS) return handleUnalias(args, session)
  if (name === SB.EXEC) {
    // The redirect-only form is intercepted where redirects are applied;
    // a bare `exec` here has none, and `exec cmd` is the
    // process-replacement form this refuses.
    return handleExecCommand(args, session)
  }
  if (name === SB.MAPFILE || name === SB.READARRAY) {
    return handleMapfile(
      args,
      session,
      stdin,
      executeFn,
      sessionView(session, registry.policies),
      name,
    )
  }
  if (name === SB.TEST || name === SB.BRACKET || name === SB.DOUBLE_BRACKET) {
    let testArgs = [...operands]
    const testName = name === SB.BRACKET ? '[' : 'test'
    if (name === SB.BRACKET) {
      const last = testArgs[testArgs.length - 1]
      if (last !== undefined && wordText(last) === ']') {
        testArgs = testArgs.slice(0, -1)
      } else {
        const err = new TextEncoder().encode("[: missing `]'\n")
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: '[', exitCode: 2, stderr: err }),
        ]
      }
    }
    return handleTest(dispatch, namespace, testArgs, session, testName)
  }
  if (name === SB.ECHO) {
    return handleEcho(args)
  }
  if (name === SB.PRINTF) {
    return handlePrintf(args, session, sessionView(session, registry.policies))
  }
  if (name === SB.SLEEP) return handleSleep(args, signal)
  if (name === SB.READ) {
    return handleRead(args, session, stdin, sessionView(session, registry.policies))
  }
  if (name === SB.SOURCE || name === SB.DOT) {
    const target = operands[0] ?? ''
    // Positional parameters keep the words as typed, so a path operand
    // contributes its spelling, not its resolved mount path.
    const sourceArgs = operands.slice(1).map((o) => wordText(o))
    return handleSource(dispatch, executeFn, target, session, sourceArgs)
  }
  if (name === SB.RETURN) {
    return handleReturn(args, session, callStack)
  }
  if (name === SB.EXIT) {
    return handleExit(args, session)
  }
  if (name === SB.BREAK) throw new BreakSignal(null, new IOResult(), loopLevels(args))
  if (name === SB.CONTINUE) throw new ContinueSignal(null, new IOResult(), loopLevels(args))

  if (name === SB.COMMAND) {
    return handleCommandBuiltin(executeFn, args, session, registry, stdin)
  }

  if (name === SB.TYPE) {
    return handleType(args, session, registry)
  }

  if (name === SB.WHICH) {
    return handleWhich(args, session, registry)
  }

  if (name === SB.XARGS) {
    return handleXargs(executeFn, args, session, stdin)
  }

  if (name === SB.TIMEOUT) {
    return handleTimeout(executeFn, args, session)
  }

  // Pathname resolution (POSIX): every component of an operand but the
  // last resolves for every command, so `stat dlink/f2` reports f2 the
  // way GNU does. The last one resolves only for a command that follows
  // (open(2) rather than lstat(2)) or an operand typed with a trailing
  // slash, which POSIX reads as `dlink/.`. This runs ahead of every
  // handler below because the kernel resolves a path before the syscall,
  // not inside it.
  if (namespace.nodes.size > 0 && operands.length > 0) {
    try {
      operands = followPaths(
        namespace,
        operands,
        followsLastComponent(name, argv.words),
        !SLASH_KEEPS_LAST.has(name),
      )
    } catch (err) {
      if (err instanceof CycleError) {
        const errBytes = new TextEncoder().encode(
          `${name}: ${err.path}: Too many levels of symbolic links\n`,
        )
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: name, exitCode: 1, stderr: errBytes }),
        ]
      }
      throw err
    }
    argv = argv.withOperands(operands)
  }

  // Symlinks are namespace-backed: not bash builtins, not mount commands.
  // They mutate the addressing layer. `readlink -f/-e/-m` is canonicalization,
  // which falls through to the mount command.
  if (name === 'ln' && linkFlags(operands, 'sfnvrT').has('s')) {
    return await handleLn(namespace, dispatch, session, operands)
  }
  if (name === 'readlink') {
    return await handleReadlink(namespace, dispatch, session, operands)
  }

  // Metadata commands (namespace-routed: resolve-then-setattr with
  // overlay fallback; they run their own link follow).
  if (name === 'chmod') {
    return handleChmod(namespace, dispatch, operands)
  }
  if (name === 'chown') {
    return handleChown(namespace, dispatch, operands)
  }
  if (name === 'chgrp') {
    return handleChgrp(namespace, dispatch, operands)
  }
  if (name === 'touch') {
    return handleTouch(namespace, dispatch, session, operands)
  }

  // Capacity (registry-routed: enumerates mounts, reports per-mount statfs;
  // never fabricates numbers).
  if (name === 'df') {
    return handleDf(registry, session, dispatch, operands)
  }

  // Symlink-aware dispatch: reads follow links (open(2)); rm/mv act on
  // the link entry itself (lstat semantics).
  let postUnlink: string | null = null
  let postRename: [string, string] | null = null
  let dispatchArgv = argv
  if (namespace.nodes.size > 0) {
    try {
      // Both remove the link entry itself, which no backend can see;
      // unlink(1) is rm(1) restricted to one non-directory. Gated on the
      // line being one the command layer accepts, because this removal
      // happens before that layer parses and it cannot be taken back
      // (GNU refuses `rm --bogus dlink` and `unlink dlink other` with
      // the link still there).
      if (
        (name === 'rm' || name === 'unlink') &&
        acceptsLine(name, argv.args, operands, session.cwd)
      ) {
        const [rest, removed] = await stripLinkOperands(namespace, operands)
        operands = rest
        if (removed > 0 && !rest.some((a) => a instanceof PathSpec)) {
          return [null, new IOResult(), new ExecutionNode({ command: name, exitCode: 0 })]
        }
      } else if (name === 'mv') {
        const prepared = await prepareMv(namespace, dispatch, operands)
        operands = prepared.items
        postUnlink = prepared.postUnlink
        postRename = prepared.postRename
        if (prepared.early !== null) return prepared.early
      }
    } catch (err) {
      if (err instanceof CycleError) {
        const errBytes = new TextEncoder().encode(
          `${name}: ${err.path}: Too many levels of symbolic links\n`,
        )
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: name, exitCode: 1, stderr: errBytes }),
        ]
      }
      throw err
    }
    dispatchArgv = argv.withOperands(operands)
  }

  // Default: mount-dispatched command
  const [stdout, io, execNode] = await handleCommand(
    recurse,
    dispatch,
    registry,
    dispatchArgv.words,
    session,
    stdin,
    callStack,
    jobTable,
    ensureOpen,
    runtimeBindings,
    namespace,
    routingDecision,
  )

  if (io.exitCode === 0 && namespace.nodes.size > 0) {
    if (name === 'rm') {
      // A removed path takes its node meta (overlay attrs) with it; a
      // removed dir purges everything underneath. Glob operands reach
      // here unexpanded (backend wrappers expand them), so the node
      // table matches the pattern itself.
      for (const item of operands) {
        if (!(item instanceof PathSpec)) continue
        // A trailing slash asked for the directory, and rm refused (or -f
        // silenced the refusal). Nothing was removed, so nothing may be
        // purged: dropping the node here deleted the very link the slash
        // protects (GNU keeps it through `rm -rf dlink/`).
        if (item.rawPath.endsWith('/')) continue
        if (item.pattern !== null) {
          // A quoted metacharacter is a literal here too, so the node
          // table is matched with the same pattern the backend resolved
          // with.
          await namespace.unlinkGlob(globPattern(item.virtual))
        } else {
          await namespace.unlink(item.virtual)
          await namespace.purgeUnder(item.virtual)
        }
      }
    }
    if (postUnlink !== null) await namespace.unlink(postUnlink)
    if (postRename !== null) await namespace.rename(postRename[0], postRename[1])
  }
  return [stdout, io, execNode]
}
