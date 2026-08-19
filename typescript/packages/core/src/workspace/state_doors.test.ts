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

import { seedVar } from '../workspace/session/state.ts'
import { VarAttr } from '../shell/variable.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { RegisteredCommand } from '../commands/config.ts'
import { CommandSpec, Operand } from '../commands/spec/types.ts'
import { runWithSession } from '../context/session_context.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry, type RegisteredOp } from '../ops/registry.ts'
import type {
  Action,
  ApprovalDecision,
  ApprovalRequest,
  CommandContext,
  OpsContext,
  Policy,
  SessionContext,
} from '../policy/index.ts'
import { CallbackApprover } from '../policy/index.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { Runtime } from '../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../runtime/mixin.ts'
import type { RunResult } from '../runtime/types.ts'
import { MountMode, ResourceName } from '../types.ts'
import { cliSpecFor } from '../commands/cli/specs.ts'
import { parseWorkspacePermissions, type SessionProfile } from './session/permissions.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()

/** Refuse one op name outright, whatever path asked. */
class DenyOp implements Policy {
  private readonly op: string
  constructor(op: string) {
    this.op = op
  }
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === this.op) return { kind: 'deny', reason: `${this.op} refused by policy` }
    return null
  }
}

// Ops resolve by resource kind in the workspace registry, so an
// overlay-backend simulation blocks registration itself.
class NoSetattrRegistry extends OpsRegistry {
  override register(ro: RegisteredOp): void {
    if (ro.name === 'setattr') return
    super.register(ro)
  }
}

const open: Workspace[] = []

async function makeWs(policies?: Policy[]): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  a.store.files.set('/x.txt', ENC.encode('public\n'))
  const b = new RAMResource()
  b.store.files.set('/y.txt', ENC.encode('other\n'))
  const ws = new Workspace(
    { '/a': a, '/b': b },
    { mode: MountMode.WRITE, shellParser: parser, ...(policies !== undefined ? { policies } : {}) },
  )
  open.push(ws)
  return ws
}

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

describe('name-plane writes go through the door', () => {
  it('ln fires the op gates', async () => {
    const ws = await makeWs([new DenyOp('symlink')])
    const io = await ws.execute('ln -s x.txt /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('Permission denied')
    expect(ws.namespace.isLink('/a/lk')).toBe(false)
  })

  it('ln leaves an op record', async () => {
    // The op ledger must not say a workspace with ln traffic did
    // nothing: the door records the namespace write like any other op.
    const ws = await makeWs()
    const io = await ws.execute('ln -s x.txt /a/lk')
    expect(io.exitCode).toBe(0)
    expect(ws.records.some((r) => r.op === 'symlink' && r.path === '/a/lk')).toBe(true)
  })

  it('scoped shell ln onto ungranted turf is refused', async () => {
    const ws = await makeWs()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    const io = await ws.execute('ln -s /a/x.txt /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.namespace.isLink('/b/lk')).toBe(false)
  })

  it('symlink and readlink answer on the fs facade', async () => {
    // readlink is the read twin: guests and CLIs ask through the same
    // door instead of a bespoke channel.
    const ws = await makeWs()
    await ws.fs.symlink('/a/lk', 'x.txt')
    expect(await ws.fs.readlink('/a/lk')).toBe('x.txt')
    expect(ws.namespace.readlink('/a/lk')).toBe('x.txt')
  })

  it('readlink on a non-link reports EINVAL', async () => {
    const ws = await makeWs()
    await expect(ws.fs.readlink('/a/x.txt')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('scoped shell readlink on ungranted turf is refused', async () => {
    // The read twin of the scoped-ln hole: a session granted only /a
    // must not learn /b/lk's target through the readlink builtin, which
    // used to read the node table directly instead of dispatching.
    const ws = await makeWs()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    const made = await ws.execute('ln -s /b/y.txt /b/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('readlink /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('y.txt')
  })

  it('scoped shell readlink -m on ungranted turf is refused', async () => {
    // -m/-f canonicalize without any existence probe, so without the
    // gate they printed the resolved target of an ungranted link.
    const ws = await makeWs()
    ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    const made = await ws.execute('ln -s /b/y.txt /b/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('readlink -m /b/lk', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('y.txt')
  })

  it('shell readlink fires the op gates', async () => {
    const ws = await makeWs([new DenyOp('readlink')])
    const made = await ws.execute('ln -s x.txt /a/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('readlink /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('x.txt')
  })

  it('facade symlink respects session grants', async () => {
    const ws = await makeWs()
    const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    await runWithSession(sess, async () => {
      await ws.fs.symlink('/a/lk', 'x.txt')
      await expect(ws.fs.symlink('/b/lk', 'y.txt')).rejects.toThrow('not allowed')
    })
    expect(ws.namespace.isLink('/a/lk')).toBe(true)
    expect(ws.namespace.isLink('/b/lk')).toBe(false)
  })

  it('chown -h on a link fires the op gates', async () => {
    // chown -h writes the link's own attrs; that overlay write used to
    // bypass the door entirely, so no policy could bound it.
    const ws = await makeWs([new DenyOp('setattr')])
    const made = await ws.execute('ln -s x.txt /a/lk')
    expect(made.exitCode).toBe(0)
    const io = await ws.execute('chown -h alice /a/lk')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(ws.namespace.metaFor('/a/lk')?.uid).toBeUndefined()
  })

  it('overlay setattr fires the op gates', async () => {
    // A backend with no native setattr op stores attrs in the namespace
    // overlay; that write must clear the same gates as a native one.
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', ENC.encode('body\n'))
    const ws = new Workspace(
      { '/o': resource },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        ops: new NoSetattrRegistry(),
        policies: [new DenyOp('setattr')],
      },
    )
    open.push(ws)
    const io = await ws.execute('chmod 600 /o/f.txt')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(ws.namespace.metaFor('/o/f.txt')?.mode).toBeUndefined()
  })

  it('overlay setattr still lands without policies', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', ENC.encode('body\n'))
    const ws = new Workspace(
      { '/o': resource },
      { mode: MountMode.WRITE, shellParser: parser, ops: new NoSetattrRegistry() },
    )
    open.push(ws)
    const io = await ws.execute('chmod 600 /o/f.txt')
    expect(io.exitCode).toBe(0)
    expect(ws.namespace.metaFor('/o/f.txt')?.mode).toBe(0o600)
  })
})

/** Veto env writes to SECRET_* names through the session view. */
class DenySecretEnv implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.plane === 'env' && ctx.key.startsWith('SECRET')) {
      return { kind: 'deny', reason: 'SECRET_* refused by policy' }
    }
    return null
  }
}

const CMD_SPEC = new CommandSpec({ rest: new Operand({ type: 'path' }) })

describe('session-state writes go through the view', () => {
  it('export fires the state gate', async () => {
    // The session plane's gate: an env write clears preSession exactly
    // as a VFS write clears preOps, whichever tier asked.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('export SECRET_X=1')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect('SECRET_X' in ws.env).toBe(false)
    const allowed = await ws.execute('export PUBLIC_X=1')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_X).toBe('1')
  })

  it('a prefix assignment clears the gate', async () => {
    // `SECRET=leak cmd` is a session write like any other, and the form
    // puts it in the command's environment, so a deployment refusing
    // `SECRET_*` has to be asked. Only the hidden half was checked here,
    // and the seeding goes through the ungated door, so the secret
    // reached the command and printed.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('SECRET_K=leak printenv SECRET_K')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect(stdoutStr(denied)).toBe('')
    // A name no rule covers still reaches the command.
    const allowed = await ws.execute('OPEN_K=fine printenv OPEN_K')
    expect(stdoutStr(allowed)).toBe('fine\n')
  })

  it('declare -x on an existing name clears the gate', async () => {
    // `declare -x NAME` on a name that already exists writes no value,
    // so the handler reaches the gate on no other path and the export
    // mark is the only session write there is. Stamping it directly let
    // an agent export a host-seeded credential the deployment refused.
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.getSession(ws.defaultSessionId)
    seedVar(sess, 'SECRET_TOKEN', 'hunter2')
    const io = await ws.execute('declare -x SECRET_TOKEN')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(sess.vars.SECRET_TOKEN?.attrs.has(VarAttr.Export)).toBe(false)
    expect(sess.vars.SECRET_TOKEN?.value).toBe('hunter2')
  })

  it('stamps what stored despite a bad sibling', async () => {
    // GNU keeps the valid operands and reports the invalid one, so
    // `declare -x GOOD=1 1BAD=x` exits 1 and still answers
    // `declare -x GOOD="1"`. Gating the stamp on the aggregate status
    // left GOOD unexported. Pinned on bash 5.2.37.
    const ws = await makeWs([])
    const bad = await ws.execute('declare -x QGOOD=1 1BAD=x')
    expect(bad.exitCode).toBe(1)
    expect(stderrStr(bad)).toContain('not a valid identifier')
    const shown = await ws.execute('declare -p QGOOD')
    expect(stdoutStr(shown)).toBe('declare -x QGOOD="1"\n')
  })

  it('command env is a snapshot, not the live dict', async () => {
    // A command's env is the process view: a child cannot write the
    // parent's environment, so a mutation must not land in the session.
    const ws = await makeWs()
    const rc = new RegisteredCommand({
      name: 'envpoke',
      spec: CMD_SPEC,
      resource: ResourceName.RAM,
      fn: (_accessor, _paths, _texts, opts) => {
        expect(opts.env).toBeDefined()
        if (opts.env !== undefined) opts.env.INJECTED = '1'
        return [new Uint8Array(), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/a').register(rc)
    const io = await ws.execute('envpoke /a/x.txt')
    expect(io.exitCode).toBe(0)
    expect('INJECTED' in ws.env).toBe(false)
  })

  it('a command can opt into the session view', async () => {
    // The LinkView pattern for the session plane: reading `sessionView`
    // off the opts is the whole opt-in, and reads answer through it.
    const ws = await makeWs()
    const rc = new RegisteredCommand({
      name: 'envread',
      spec: CMD_SPEC,
      resource: ResourceName.RAM,
      fn: (_accessor, _paths, _texts, opts) => {
        const value = opts.sessionView?.get('MARKER') ?? 'none'
        return [ENC.encode(value), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/a').register(rc)
    await ws.execute('export MARKER=yes')
    const io = await ws.execute('envread /a/x.txt')
    expect(stdoutStr(io).trim()).toBe('yes')
  })
})

describe('the remaining session writers clear the same gate', () => {
  it('bare export of a new name fires the gate', async () => {
    // `export NAME` writes no value, but marking a name is still a
    // session write, so it clears the same gate an assignment does.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('export SECRET_BARE')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect('SECRET_BARE' in ws.env).toBe(false)
    const allowed = await ws.execute('export PUBLIC_BARE')
    expect(allowed.exitCode).toBe(0)
    // Marked but unset, which is bash's third state: `export -p` lists
    // it bare while the environment does not carry it at all.
    expect(ws.env.PUBLIC_BARE).toBeUndefined()
    const listed = stdoutStr(await ws.execute('export -p'))
    expect(listed).toContain('declare -x PUBLIC_BARE\n')
    expect(listed).not.toContain('SECRET_BARE')
  })

  it('local fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('f() { local SECRET_L=1; }; f')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect('SECRET_L' in ws.env).toBe(false)
  })

  it('every declaring spelling fires the gate', async () => {
    // `readonly NAME` marked through `setAttr` and walked straight past
    // it: a deployment refusing SECRET_* still saw the line exit 0,
    // create the record, and freeze the name against every later write
    // the deployment's own wiring would make.
    const ws = await makeWs([new DenySecretEnv()])
    const session = ws.getSession(ws.defaultSessionId)
    for (const line of [
      'SECRET_A=1',
      'export SECRET_B',
      'readonly SECRET_C',
      'readonly SECRET_D=1',
      'declare SECRET_E',
    ]) {
      const io = await ws.execute(line)
      expect(io.exitCode, line).not.toBe(0)
      expect(stderrStr(io), line).toContain('refused by policy')
    }
    for (const name of ['SECRET_A', 'SECRET_B', 'SECRET_C', 'SECRET_D', 'SECRET_E']) {
      expect(name in session.vars, name).toBe(false)
    }
  })

  it('a plain assignment fires the gate', async () => {
    // The assignment path used to write session.env directly, so a
    // policy that vetoed `export SECRET_X=1` still admitted
    // `SECRET_X=1`. Denial mirrors the readonly case: a fatal
    // variable-assignment error that abandons the rest of the line.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('SECRET_P=1; echo after')
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toContain('refused by policy')
    expect('SECRET_P' in ws.env).toBe(false)
    const allowed = await ws.execute('PUBLIC_P=1')
    expect(allowed.exitCode).toBe(0)
    expect(ws.env.PUBLIC_P).toBe('1')
  })

  it('an append assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_A+=x')
    expect(io.exitCode).not.toBe(0)
    expect('SECRET_A' in ws.env).toBe(false)
  })

  it('an array assignment fires the gate', async () => {
    // A denied name must not be writable by switching to array syntax:
    // SECRET=(a b) lands on the same session plane as SECRET=x.
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_V=(a b); echo after')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_V' in sess.arrays).toBe(false)
  })

  it('an array append assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_VA+=(a)')
    expect(io.exitCode).not.toBe(0)
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_VA' in sess.arrays).toBe(false)
  })

  it('a subscript assignment fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('SECRET_S[0]=x')
    expect(io.exitCode).not.toBe(0)
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_S' in sess.arrays).toBe(false)
    expect('SECRET_S' in ws.env).toBe(false)
  })

  it('a scalar append onto an existing array fires the gate', async () => {
    // SECRET+=x on a name that already holds an array appends to
    // element 0 through a branch of its own; it is still a session
    // write.
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    seedVar(sess, 'SECRET_E', ['a'])
    const io = await ws.execute('SECRET_E+=x')
    expect(io.exitCode).not.toBe(0)
    expect(sess.arrays.SECRET_E).toEqual(['a'])
  })

  it('a declaration array assignment fires the gate', async () => {
    // export/declare with an array literal store through the staged
    // path, not handleExport, so the gate has to fire there too.
    const ws = await makeWs([new DenySecretEnv()])
    const io = await ws.execute('export SECRET_D=(a)')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('SECRET_D' in sess.arrays).toBe(false)
  })

  it('a readonly name refuses a declaration array store', async () => {
    // The staged-array store is the builtin's own; the shell's readonly
    // rule is pre-checked there, before the door is asked.
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const io = await ws.execute('export LOCKED=(a)')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('readonly variable')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect('LOCKED' in sess.arrays).toBe(false)
  })

  it('a readonly declaration array abandons the line', async () => {
    // GNU treats `export LOCKED=(a)` on a readonly name as a variable
    // assignment error, not a builtin failure: the rest of the line is
    // dead (status 1) and the next line runs. Pinned on bash 5.2
    // (debian:stable-slim); the scalar spelling below continues.
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const denied = await ws.execute('export LOCKED=(a); echo unreached')
    expect(denied.exitCode).toBe(1)
    expect(stdoutStr(denied)).toBe('')
    expect(stderrStr(denied)).toBe('bash: LOCKED: readonly variable\n')
    const after = await ws.execute('echo after')
    expect(after.exitCode).toBe(0)
  })

  it('a readonly declare array is fatal at top level', async () => {
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const denied = await ws.execute('declare LOCKED=(a); echo unreached')
    expect(denied.exitCode).toBe(1)
    expect(stdoutStr(denied)).toBe('')
  })

  it('a readonly scalar export refusal continues the line', async () => {
    // The asymmetry is GNU's: `export LOCKED=v` fails with 1 in the
    // builtin's voice and the same line keeps going.
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const io = await ws.execute('export LOCKED=v; echo rc=$?')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('rc=1\n')
  })

  it('a readonly local array refusal stays in the function', async () => {
    // `local LOCKED=(a)` on a readonly global refuses without killing
    // the function body (GNU prints the refusal and runs `echo in-f`).
    const ws = await makeWs()
    await ws.execute('readonly LOCKED')
    const io = await ws.execute('f() { local LOCKED=(a); echo in-f; }; f')
    expect(stdoutStr(io)).toContain('in-f')
    expect(stderrStr(io)).toContain('readonly variable')
  })

  it('export of an array literal prints nothing', async () => {
    // `export ARR=(x y)` used to fall through to the bare-export print
    // branch because the handler never learned arrays were on the line.
    const ws = await makeWs()
    const io = await ws.execute('export ARR=(x y)')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('')
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect(sess.arrays.ARR).toEqual(['x', 'y'])
  })

  it('a readonly loop variable refuses before the body', async () => {
    // bash refuses a readonly loop variable and never runs the body;
    // the loop writes go through the view now, same as any assignment.
    const ws = await makeWs()
    await ws.execute('readonly LV')
    const denied = await ws.execute('for LV in a b; do echo ran; done')
    expect(denied.exitCode).not.toBe(0)
    expect(stdoutStr(denied)).not.toContain('ran')
  })

  it('a subscripted unset of a scalar fires the gate', async () => {
    // `unset 'SECRET[0]'` on a scalar is the whole unset in element
    // clothing; the element branch used to skip the view entirely.
    const ws = await makeWs([new DenySecretEnv()])
    seedVar(ws.getSession(ws.defaultSessionId), 'SECRET_U', 'v')
    const io = await ws.execute("unset 'SECRET_U[0]'")
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('refused by policy')
    expect(ws.env.SECRET_U).toBe('v')
  })

  it('a subscripted unset of an array element fires the gate', async () => {
    const ws = await makeWs([new DenySecretEnv()])
    const sess = ws.sessionManager.get(ws.sessionManager.defaultId)
    seedVar(sess, 'SECRET_W', ['a', 'b'])
    const io = await ws.execute("unset 'SECRET_W[1]'")
    expect(io.exitCode).not.toBe(0)
    expect(sess.arrays.SECRET_W).toEqual(['a', 'b'])
  })

  it('the for-loop variable fires the gate', async () => {
    // The loop variable is a session write per iteration; a denied
    // write aborts the loop before its body runs.
    const ws = await makeWs([new DenySecretEnv()])
    const denied = await ws.execute('for SECRET_I in a b; do echo ran; done')
    expect(denied.exitCode).not.toBe(0)
    expect(stdoutStr(denied)).not.toContain('ran')
    expect('SECRET_I' in ws.env).toBe(false)
    const allowed = await ws.execute('for PUB_I in a b; do echo ok; done')
    expect(allowed.exitCode).toBe(0)
    expect(stdoutStr(allowed).match(/ok/g)?.length).toBe(2)
  })
})

async function makeHiddenVarsWs(): Promise<Workspace> {
  const ws = await makeWs()
  const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
  seedVar(sess, 'SLACK_TOKEN', 'xoxb-real')
  seedVar(sess, 'PUBLIC', 'ok')
  sess.hiddenVars = { names: ['SLACK_TOKEN'] }
  return ws
}

describe('hidden vars across the shell tier', () => {
  it('assign-default writes the raw env under hidden vars', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('echo "${NEWVAR:=seeded}" && echo "$NEWVAR"', {
      sessionId: 'agent',
    })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('seeded\nseeded\n')
    expect(ws.getSession('agent').env.NEWVAR).toBe('seeded')
  })

  it('assign-default of a hidden var is refused', async () => {
    // ${SLACK_TOKEN:=fake} observes the hidden name as unset, so
    // without a gate the write-back would overwrite the real value
    // the host's wiring still reads; the door refuses like any denied
    // assignment.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('echo "${SLACK_TOKEN:=fake}"', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('arithmetic assignment of a hidden var is refused', async () => {
    // $((X=5)) and ((X=5)) write the raw env on purpose, but a hidden
    // name is not theirs to clobber; both spellings refuse.
    const ws = await makeHiddenVarsWs()
    const expansion = await ws.execute('echo "$((SLACK_TOKEN=5))"', { sessionId: 'agent' })
    expect(expansion.exitCode).not.toBe(0)
    const command = await ws.execute('((SLACK_TOKEN=7))', { sessionId: 'agent' })
    expect(command.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('printf -v of a hidden var is refused', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('printf -v SLACK_TOKEN fake', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('expansion reads a hidden var as unset', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('echo "[$SLACK_TOKEN][$PUBLIC]"', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[][ok]\n')
  })

  it('env and set listings omit hidden vars', async () => {
    const ws = await makeHiddenVarsWs()
    for (const line of ['env', 'set', 'export -p']) {
      const io = await ws.execute(line, { sessionId: 'agent' })
      expect(stdoutStr(io)).not.toContain('SLACK_TOKEN')
    }
  })

  it('exporting a hidden var is refused and preserves it', async () => {
    // A landed write would clobber the real value the host's wiring
    // still reads; a swallowed one would gaslight the agent.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('export SLACK_TOKEN=fake', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('unset of a hidden var is quiet and preserves it', async () => {
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('unset SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('a hidden HOME reads as unset everywhere', async () => {
    // HOME has its own resolution channel (homeDir feeds $HOME, tilde
    // expansion and bare `cd`), so hiding it must land there too, not
    // only on the generic env lookup.
    const ws = await makeHiddenVarsWs()
    const sess = ws.getSession('agent')
    seedVar(sess, 'HOME', '/a/homedir')
    sess.hiddenVars = { names: ['SLACK_TOKEN', 'HOME'] }
    const home = await ws.execute('echo "[$HOME]"', { sessionId: 'agent' })
    expect(stdoutStr(home)).toBe('[]\n')
    const tilde = await ws.execute('echo ~', { sessionId: 'agent' })
    expect(stdoutStr(tilde)).toBe('~\n')
    const cd = await ws.execute('cd', { sessionId: 'agent' })
    expect(cd.exitCode).toBe(1)
  })

  it('expansion reads a hidden array as unset', async () => {
    // The embedder can seed session.arrays before narrowing, so a
    // hidden name can hold an array; every expansion spelling must
    // read it the way the scalar case does: as unset.
    const ws = await makeHiddenArrayWs()
    const io = await ws.execute(
      'echo "[$SLACK_TOKEN][${SLACK_TOKEN[0]}][${SLACK_TOKEN[@]}][${#SLACK_TOKEN[@]}]"',
      { sessionId: 'agent' },
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[][][][0]\n')
    const splat = await ws.execute(
      'for el in "${SLACK_TOKEN[@]}"; do echo "el=$el"; done; echo end',
      { sessionId: 'agent' },
    )
    expect(splat.exitCode).toBe(0)
    expect(stdoutStr(splat)).toBe('end\n')
  })

  it('a prefix assignment of a hidden var is refused', async () => {
    // SLACK_TOKEN=fake cmd writes the raw env before dispatch, and a
    // function-call prefix deliberately never restores, so without a
    // gate a narrowed session permanently clobbers the host value.
    const ws = await makeHiddenVarsWs()
    await ws.execute('f() { echo ran; }', { sessionId: 'agent' })
    const fn = await ws.execute('SLACK_TOKEN=fake f', { sessionId: 'agent' })
    expect(fn.exitCode).not.toBe(0)
    const cmd = await ws.execute('SLACK_TOKEN=fake echo hi', { sessionId: 'agent' })
    expect(cmd.exitCode).not.toBe(0)
    const bare = await ws.execute('SLACK_TOKEN=fake OTHER=x', { sessionId: 'agent' })
    expect(bare.exitCode).not.toBe(0)
    const sess = ws.getSession('agent')
    expect(sess.env.SLACK_TOKEN).toBe('xoxb-real')
    expect('OTHER' in sess.env).toBe(false)
  })

  it('bare declare -a of a hidden var is refused', async () => {
    // `declare -a NAME` at top level migrates an existing scalar into
    // element 0 with raw writes, which would move the hidden value
    // into array storage; the door refuses instead.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('declare -a SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    const sess = ws.getSession('agent')
    expect(sess.env.SLACK_TOKEN).toBe('xoxb-real')
    expect('SLACK_TOKEN' in sess.arrays).toBe(false)
  })

  it('unset of a hidden array is a quiet noop', async () => {
    // `unset name` and `unset name[i]` on a hidden array answer as
    // they would for an unset name: exit 0, nothing said, nothing
    // written, in either spelling.
    const ws = await makeHiddenArrayWs()
    const element = await ws.execute('unset "SLACK_TOKEN[1]"', { sessionId: 'agent' })
    expect(element.exitCode).toBe(0)
    const whole = await ws.execute('unset SLACK_TOKEN', { sessionId: 'agent' })
    expect(whole.exitCode).toBe(0)
    expect(ws.getSession('agent').arrays.SLACK_TOKEN).toEqual(['xoxb-real', 'xoxb-two'])
  })

  it('bare export of a hidden var is refused', async () => {
    // `export NAME` on a name that reads as unset writes an empty
    // entry, so on a hidden name it refuses like the valued form;
    // deciding from raw membership would quietly re-mark the hidden
    // name instead.
    const ws = await makeHiddenVarsWs()
    const io = await ws.execute('export SLACK_TOKEN', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(ws.getSession('agent').env.SLACK_TOKEN).toBe('xoxb-real')
  })

  it('subscript arithmetic resolves against the visible env', async () => {
    // An assignment subscript evaluates as arithmetic, so a hidden
    // numeric read there would steer a visible array's write index
    // and leak by placement; hidden reads as unset, which is 0.
    const ws = await makeWs()
    const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
    seedVar(sess, 'SECRET_IDX', '1')
    sess.hiddenVars = { names: ['SECRET_IDX'] }
    await ws.execute('b=(x y)', { sessionId: 'agent' })
    const io = await ws.execute('b[SECRET_IDX]=z', { sessionId: 'agent' })
    expect(io.exitCode).toBe(0)
    expect(ws.getSession('agent').arrays.b).toEqual(['z', 'y'])
  })
})

async function makeHiddenArrayWs(): Promise<Workspace> {
  const ws = await makeWs()
  const sess = ws.createSession('agent', { mounts: { '/a': MountMode.WRITE } })
  seedVar(sess, 'SLACK_TOKEN', ['xoxb-real', 'xoxb-two'])
  seedVar(sess, 'PUBLIC', 'ok')
  sess.hiddenVars = { names: ['SLACK_TOKEN'] }
  return ws
}

async function makeHiddenPathsWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  a.store.files.set('/x.txt', ENC.encode('public\n'))
  a.store.files.set('/secrets/token.txt', ENC.encode('s3cr3t\n'))
  a.store.files.set('/note.key', ENC.encode('kkk\n'))
  a.store.dirs.add('/secrets')
  const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
  open.push(ws)
  const sess = ws.createSession('agent')
  sess.hiddenPaths = { paths: ['/a/secrets'], patterns: ['*.key'] }
  return ws
}

describe('hidden paths across the tiers', () => {
  it('the shell reads a hidden path as missing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('cat /a/secrets/token.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('s3cr3t')
    expect(stderrStr(io)).toContain('No such file')
  })

  it('a pattern-hidden file reads as missing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('cat /a/note.key', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('kkk')
  })

  it('ls drops hidden names', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('ls /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('note.key')
  })

  it('find predicates evaluate on the visible tree', async () => {
    // RAM ships a native find op, which classifies on the raw tree: a
    // visible directory whose only child is hidden would read as
    // nonempty there, so -empty would omit it and reveal that an
    // unseen child exists. Under hidden paths the generic must walk
    // through the guarded readdir instead.
    const parser = await getTestParser()
    const a = new RAMResource()
    a.store.files.set('/x.txt', ENC.encode('public\n'))
    a.store.files.set('/vault/only.key', ENC.encode('kkk\n'))
    a.store.dirs.add('/vault')
    const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
    open.push(ws)
    const sess = ws.createSession('agent')
    sess.hiddenPaths = { patterns: ['*.key'] }
    const io = await ws.execute('find /a -empty', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('/a/vault')
    expect(out).not.toContain('only.key')
  })

  it('ls of a hidden dir is no such file', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('ls /a/secrets', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('token')
  })

  it('find never reports hidden rows', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('find /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('/a/x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('.key')
  })

  it('du never counts hidden leaves', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('du -a /a', { sessionId: 'agent' })
    const out = stdoutStr(io)
    expect(out).toContain('x.txt')
    expect(out).not.toContain('secrets')
    expect(out).not.toContain('.key')
  })

  it('a glob never matches a hidden name', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('cat /a/*.key', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    expect(stdoutStr(io)).not.toContain('kkk')
  })

  it('a redirect into hidden space fails and writes nothing', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('echo hi > /a/secrets/new.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
    const a = ws.namespace.mountFor('/a/x.txt')
    const resource = a.resource as RAMResource
    expect(resource.store.files.has('/secrets/new.txt')).toBe(false)
  })

  it('the unscoped session sees everything', async () => {
    const ws = await makeHiddenPathsWs()
    const io = await ws.execute('ls /a')
    const out = stdoutStr(io)
    expect(out).toContain('secrets')
    expect(out).toContain('note.key')
  })

  it('the fs facade agrees with the shell', async () => {
    const ws = await makeHiddenPathsWs()
    const sess = ws.getSession('agent')
    await runWithSession(sess, async () => {
      await expect(ws.fs.readFile('/a/secrets/token.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const names = await ws.fs.readdir('/a')
      expect(names.some((n) => n.includes('secrets'))).toBe(false)
    })
  })
})

describe('session profiles', () => {
  it('a profile applies every narrowing field end to end', async () => {
    const parser = await getTestParser()
    const a = new RAMResource()
    a.store.files.set('/x.txt', ENC.encode('public\n'))
    a.store.files.set('/secrets/token.txt', ENC.encode('s3cr3t\n'))
    a.store.dirs.add('/secrets')
    const ws = new Workspace({ '/a': a }, { mode: MountMode.WRITE, shellParser: parser })
    open.push(ws)
    const analyst = {
      mounts: { '/a': 'write' },
      paths: { hide: ['/a/secrets'] },
      vars: { hide: ['SLACK_TOKEN'] },
      env: { ROLE: 'analyst' },
    }
    const s1 = ws.createSession('agent1', { profile: analyst })
    const s2 = ws.createSession('agent2', { profile: analyst })
    expect(s1.mountModes?.get('/a')).toBe(MountMode.WRITE)
    expect(s1.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(s2.hiddenPaths).toEqual(s1.hiddenPaths)
    expect(s1.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    expect(s1.env.ROLE).toBe('analyst')
    const listing = await ws.execute('ls /a', { sessionId: 'agent1' })
    expect(stdoutStr(listing)).not.toContain('secrets')
    const role = await ws.execute('echo "$ROLE"', { sessionId: 'agent1' })
    expect(stdoutStr(role)).toBe('analyst\n')
  })

  it('explicit mounts tighten the profile, never widen it', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMResource(), '/b': new RAMResource() },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    open.push(ws)
    const sess = ws.createSession('agent', {
      mounts: { '/a': 'read', '/b': 'read' },
      profile: { mounts: { '/a': 'write' }, paths: { hide: ['/a/secrets'] } },
    })
    expect(sess.mountModes?.get('/a')).toBe(MountMode.READ)
    expect(sess.mountModes?.has('/b')).toBe(false)
    expect(sess.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: [] })
  })

  it('a named profile resolves its chain, default applies unnamed, unknown throws', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMResource(), '/b': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: { cwd: '/b', env: { PAGER: 'cat' }, mounts: { '/a': 'rw', '/b': 'rwx' } },
          reviewer: {
            extends: 'default',
            mounts: { '/a': 'r', '/b': 'rwx' },
            paths: { hide: ['/a/secrets'] },
          },
        },
      },
    )
    open.push(ws)
    const reviewer = ws.createSession('r', { profile: 'reviewer' })
    expect(reviewer.mountModes?.get('/a')).toBe(MountMode.READ)
    expect(reviewer.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(reviewer.cwd).toBe('/b')
    expect(reviewer.env.PAGER).toBe('cat')
    const dflt = ws.createSession('d')
    expect(dflt.mountModes?.get('/a')).toBe(MountMode.WRITE)
    expect(dflt.hiddenPaths).toBeNull()
    expect(dflt.cwd).toBe('/b')
    expect(() => ws.createSession('x', { profile: 'nope' })).toThrow("unknown profile 'nope'")
    const inline = ws.createSession('i', {
      profile: 'reviewer',
      permissions: {
        cwd: '/a',
        mounts: { '/a': 'rw' },
        paths: { hide: ['*.key'] },
        vars: { hide: ['AWS_*'] },
      },
    })
    expect(inline.mountModes?.get('/a')).toBe(MountMode.READ)
    expect(inline.mountModes?.has('/b')).toBe(false)
    expect(inline.hiddenPaths).toEqual({ paths: ['/a/secrets'], patterns: ['*.key'] })
    expect(inline.hiddenVars).toEqual({ names: [], patterns: ['AWS_*'] })
    expect(inline.cwd).toBe('/a')
    const pwd = await ws.execute('pwd', { sessionId: 'r' })
    expect(stdoutStr(pwd)).toBe('/b\n')
  })

  it('a broken profile chain fails at construction', () => {
    expect(
      () =>
        new Workspace({ '/a': new RAMResource() }, { profiles: { orphan: { extends: 'gone' } } }),
    ).toThrow("extends unknown profile 'gone'")
  })

  it('the default profile shapes the workspace session too', async () => {
    // The workspace's own session is a session created without a name,
    // so `profiles.default` reaches it: the primary agent starts in the
    // profile's cwd, sees its exported env and its mount ceilings, and
    // cannot see what it hides. No default profile leaves it as it was.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMResource(), '/b': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: {
          default: {
            cwd: '/b',
            env: { PAGER: 'cat' },
            mounts: { '/b': 'rwx' },
            paths: { hide: ['/b/vault'] },
          },
        },
      },
    )
    open.push(ws)
    const dflt = ws.getSession(ws.defaultSessionId)
    expect(dflt.mountModes?.get('/b')).toBe(MountMode.EXEC)
    expect(dflt.mountModes?.has('/a')).toBe(false)
    expect(dflt.hiddenPaths).toEqual({ paths: ['/b/vault'], patterns: [] })
    expect(dflt.cwd).toBe('/b')
    expect(stdoutStr(await ws.execute('pwd'))).toBe('/b\n')
    expect(stdoutStr(await ws.execute('echo "$PAGER"'))).toBe('cat\n')
    expect((await ws.execute('ls /a')).exitCode).not.toBe(0)
    expect((await ws.execute('mkdir /b/vault')).exitCode).not.toBe(0)
    const plain = new Workspace({ '/a': new RAMResource() }, { shellParser: parser })
    open.push(plain)
    const own = plain.getSession(plain.defaultSessionId)
    expect(own.mountModes).toBeNull()
    expect(own.hiddenPaths).toBeNull()
  })

  it('workspace and mount-owned hides bind every session, the default included', async () => {
    const parser = await getTestParser()
    const repo = new RAMResource()
    const ws = new Workspace(
      { '/repo': repo, '/other': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: { commands: { deny: [] }, paths: { hide: ['/other/finance', '*.key'] } },
        mountPermissions: { '/repo': { paths: { hide: ['.env', '*.pem'] } } },
      },
    )
    open.push(ws)
    await ws.execute('mkdir -p /repo/certs /other/finance /other/pub')
    await ws.execute(
      "printf 'S=1\\n' > /repo/.env; printf p > /repo/certs/k.pem; printf r > /repo/README",
    )
    await ws.execute('printf v > /other/.env; printf v > /other/x.pem; printf k > /other/pub/b.key')
    const listing = stdoutStr(await ws.execute('ls -a /repo /repo/certs /other /other/pub'))
    expect(listing).toContain('README')
    expect(listing).not.toContain('k.pem')
    expect(listing).not.toContain('finance')
    expect(listing).not.toContain('b.key')
    expect(listing).toContain('x.pem')
    const repoPart = listing.split('/other:')[0]
    expect(repoPart).not.toContain('.env')
    expect(listing.split('/other:')[1]).toContain('.env')
    expect((await ws.execute('cat /repo/.env')).exitCode).not.toBe(0)
    expect(stdoutStr(await ws.execute('cat /other/.env'))).toBe('v')
    ws.createSession('late')
    expect((await ws.execute('cat /other/pub/b.key', { sessionId: 'late' })).exitCode).not.toBe(0)
    expect(ws.getSession('late').hiddenPaths).toBeNull()
  })
})

describe('command permissions end to end', () => {
  const COMMANDS_DOC = {
    commands: {
      allow: [
        'ls',
        'cat',
        'echo',
        'rm',
        'git',
        'python3',
        'mkdir',
        'touch',
        'head',
        'xargs',
        'wc',
        'man',
        'find',
      ],
      deny: [
        { reason: 'no deletes in the repo', commands: ['rm'], paths: ['/repo/*'] },
        { reason: 'frozen', paths: ['/repo/locked/*'] },
      ],
    },
    paths: { hide: [] },
  }
  const REVIEWER: SessionProfile = {
    commands: { allow: ['ls', 'cat', 'echo', 'git log', 'git status', 'xargs'], deny: [] },
  }

  async function commandsWs(): Promise<Workspace> {
    const parser = await getTestParser()
    // The frozen subtree is seeded on the resource: the pure path rule
    // holds at every op door, the host's `ws.ops` included.
    const repo = new RAMResource()
    repo.store.dirs.add('/locked')
    repo.store.files.set('/locked/y', ENC.encode('y\n'))
    const ws = new Workspace(
      { '/repo': repo, '/scratch': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: COMMANDS_DOC,
        mountPermissions: {
          '/repo': {
            paths: { hide: [] },
            commands: {
              deny: [
                {
                  reason: 'history is read-only here',
                  commands: ['git commit', 'git reset --hard'],
                },
              ],
            },
          },
        },
        profiles: { reviewer: REVIEWER },
      },
    )
    open.push(ws)
    ws.registerCli('git', cliSpecFor('git'))
    return ws
  }

  async function line(
    ws: Workspace,
    text: string,
    sessionId?: string,
  ): Promise<[number, string, string]> {
    const r = await ws.execute(text, sessionId === undefined ? {} : { sessionId })
    return [r.exitCode, stdoutStr(r), stderrStr(r)]
  }

  it('an allow list hides unlisted tools from dispatch and the enumerators', async () => {
    const ws = await commandsWs()
    await ws.execute('mkdir -p /repo/d && touch /repo/d/x')
    // An unlisted tool is not a command for the session: 127 before any
    // admission hook, and every enumerator agrees.
    expect(await line(ws, 'sort /repo/d/x')).toEqual([127, '', 'sort: command not found\n'])
    expect(await line(ws, 'type sort; echo $?')).toEqual([0, '1\n', 'type: sort: not found\n'])
    expect(await line(ws, 'command -v sort; echo $?')).toEqual([0, '1\n', ''])
    expect(await line(ws, 'which sort; echo $?')).toEqual([0, '1\n', ''])
    const [code, out] = await line(ws, 'man')
    expect(code).toBe(0)
    expect(out).toContain('- cat')
    expect(out).not.toContain('- sort')
    expect((await line(ws, 'man sort'))[0]).toBe(1)
    // Grammar-tier builtins and functions are not subjects; a listed
    // tool runs; the workspace's own session is bound like any other.
    expect(await line(ws, 'cd /repo && [ -f d/x ] && echo yes')).toEqual([0, 'yes\n', ''])
    expect(await line(ws, 'f() { echo in-f; }; f')).toEqual([0, 'in-f\n', ''])
    expect((await line(ws, 'cat /repo/d/x'))[0]).toBe(0)
    // `history` is a tool-tier builtin: hidden when unlisted.
    expect(await line(ws, 'history')).toEqual([127, '', 'history: command not found\n'])
  })

  it('a profile allow list intersects with the workspace tier', async () => {
    const ws = await commandsWs()
    ws.createSession('rev', { profile: 'reviewer' })
    await ws.execute('mkdir -p /repo/d && touch /repo/d/x')
    // Both tiers list `cat`; the workspace lists python3, the profile
    // does not; the profile lists `git log`, so `git` is visible but a
    // `git commit` line is covered by nothing (a refusal that names the
    // program, not "command not found").
    expect((await line(ws, 'cat /repo/d/x', 'rev'))[0]).toBe(0)
    expect(await line(ws, 'python3 -c 1', 'rev')).toEqual([127, '', 'python3: command not found\n'])
    expect((await line(ws, 'type git', 'rev'))[0]).toBe(0)
    expect(await line(ws, 'git commit -m x', 'rev')).toEqual([
      126,
      '',
      'git: policy denied: git commit is not allowed\n',
    ])
    // The verb walk normalizes the line: options before the verb are
    // not the verb, so `git -C /repo status` is `git status`.
    expect((await line(ws, 'git -C /repo status', 'rev'))[2]).not.toContain('not allowed')
    // Nested runners re-enter the chokepoint: the hidden `rm` stays
    // hidden inside xargs, eval and a function body.
    expect(await line(ws, 'echo /repo/d/x | xargs rm', 'rev')).toEqual([
      127,
      '',
      'rm: command not found\n',
    ])
    expect(await line(ws, "eval 'rm /repo/d/x'", 'rev')).toEqual([
      127,
      '',
      'rm: command not found\n',
    ])
    expect(await line(ws, 'f() { rm /repo/d/x; }; f', 'rev')).toEqual([
      127,
      '',
      'rm: command not found\n',
    ])
    // An inline document tightens further: allow lists intersect.
    ws.createSession('tight', {
      profile: 'reviewer',
      permissions: { commands: { allow: ['cat', 'git'], deny: [] } },
    })
    expect((await line(ws, 'cat /repo/d/x', 'tight'))[0]).toBe(0)
    expect(await line(ws, 'ls /repo', 'tight')).toEqual([127, '', 'ls: command not found\n'])
    expect((await line(ws, 'git log', 'tight'))[2]).not.toContain('not allowed')
  })

  it('deny rules by tier, scope and voice', async () => {
    const ws = await commandsWs()
    await ws.execute('mkdir -p /repo/d && touch /repo/d/x /scratch/z')
    // Operand-scoped: the GNU voice at 1, the operand as typed.
    expect(await line(ws, 'cd /repo/d && rm x')).toEqual([1, '', 'rm: x: no deletes in the repo\n'])
    expect((await line(ws, 'rm /scratch/z'))[0]).toBe(0)
    // A pure path rule holds at the command plane for any command and
    // at the op door for every op, whatever door.
    expect(await line(ws, 'cat /repo/locked/y')).toEqual([1, '', 'cat: /repo/locked/y: frozen\n'])
    await expect(ws.fs.writeFile('/repo/locked/y', 'changed')).rejects.toThrow()
    await expect(ws.fs.readFile('/repo/locked/y')).rejects.toThrow()
    // Mount tier: applies when the line works inside the mount (cwd
    // under it, or a path under it), speaks first, whole command; the
    // verb walk reads `-C /repo reset --hard` as `git reset --hard`.
    expect(await line(ws, 'cd /repo && git commit -m x')).toEqual([
      126,
      '',
      'git: policy denied: history is read-only here\n',
    ])
    expect(await line(ws, 'cd /scratch && git -C /repo reset --hard')).toEqual([
      126,
      '',
      'git: policy denied: history is read-only here\n',
    ])
    expect((await line(ws, 'cd /scratch && git commit -m x'))[2]).not.toContain('read-only')
    expect((await line(ws, 'cd /repo && git reset --soft HEAD'))[2]).not.toContain('read-only')
  })

  it('find -delete is gated at the op door, not by a named rule', async () => {
    // mirage's find has no -exec; -delete is find's own action, not an
    // `rm` line, so a rule naming `rm` does not cover it (the same
    // honest limit as a guest's os.remove), while a pure path rule does,
    // at the op door the removal clears.
    const ws = await commandsWs()
    await ws.execute('mkdir -p /repo/d && touch /repo/d/x')
    await ws.execute('find /repo/d -name x -delete')
    expect((await line(ws, 'cat /repo/d/x'))[0]).not.toBe(0)
    expect(await line(ws, 'find /repo/locked -name y -delete')).toEqual([
      1,
      '',
      "find: cannot delete '/repo/locked/y': frozen\n",
    ])
    expect((await line(ws, 'cat /repo/locked/y'))[0]).toBe(1)
  })

  it('a command-scoped path rule reads the path the command touches', async () => {
    // A command-scoped rule never runs at the op door, so the command
    // plane has to see the path the command will actually touch: for a
    // command that follows links (open(2)) that is the target, for one
    // that acts on the link itself (rm, lstat(2)) it is the link.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: {
          commands: {
            deny: [
              { reason: 'sealed', commands: ['cat', 'head'], paths: ['/data/secret*'] },
              { reason: 'keep the link', commands: ['rm'], paths: ['/data/link'] },
            ],
          },
          paths: { hide: [] },
        },
      },
    )
    open.push(ws)
    await ws.execute(
      'echo top > /data/secret && ln -s /data/secret /data/link && ln -s /data/secret /data/other',
    )
    expect(await line(ws, 'cat /data/secret')).toEqual([1, '', 'cat: /data/secret: sealed\n'])
    // Through the link: refused, the operand named as typed.
    expect(await line(ws, 'cat /data/link')).toEqual([1, '', 'cat: /data/link: sealed\n'])
    expect(await line(ws, 'head -n 1 /data/other')).toEqual([1, '', 'head: /data/other: sealed\n'])
    // rm removes the link, not the target: the target's rule does not
    // apply, the link's own does.
    expect(await line(ws, 'rm /data/other')).toEqual([0, '', ''])
    expect(await line(ws, 'rm /data/link')).toEqual([1, '', 'rm: /data/link: keep the link\n'])
    expect((await line(ws, 'cat /data/link'))[0]).toBe(1)
  })

  it('a whole-line runtime is gated like the tree', async () => {
    // A runtime that captures the raw line runs it under the same
    // tiers: every parsed command clears visibility, the policy chain
    // and the approval door before the runtime sees a byte, so a
    // captured line cannot run what the tree would refuse.
    const parser = await getTestParser()
    const box = new Box()
    const ws = new Workspace(
      { '/repo': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: COMMANDS_DOC,
        profiles: { reviewer: REVIEWER },
        runtimes: [box, 'vfs'],
      },
    )
    open.push(ws)
    ws.registerCli('git', cliSpecFor('git'))
    expect(await line(ws, 'sort /repo/x')).toEqual([127, '', 'sort: command not found\n'])
    expect(await line(ws, 'cat /repo/a | sort')).toEqual([127, '', 'sort: command not found\n'])
    expect(await line(ws, 'rm /repo/x')).toEqual([1, '', 'rm: /repo/x: no deletes in the repo\n'])
    expect(await line(ws, 'cat /repo/a; rm -f /repo/x')).toEqual([
      1,
      '',
      'rm: /repo/x: no deletes in the repo\n',
    ])
    expect(box.lines).toEqual([])
    expect(await line(ws, 'cat /repo/a | wc -l')).toEqual([0, 'box:cat /repo/a | wc -l', ''])
    ws.createSession('rev', { profile: 'reviewer' })
    expect(await line(ws, 'git add x', 'rev')).toEqual([
      126,
      '',
      'git: policy denied: git add is not allowed\n',
    ])
    expect((await line(ws, 'git status', 'rev'))[0]).toBe(0)
    expect(box.lines).toEqual(['cat /repo/a | wc -l', 'git status'])
  })

  it('a whole-line runtime reads only literal words', async () => {
    // The runtime expands the line, so the gate reads it as typed and
    // refuses what only the runtime could read where a rule in force
    // would have read it: the command name under any rule, an argument
    // where a rule reads that command's arguments, and a line a word
    // runs that the gate cannot see into.
    const parser = await getTestParser()
    const box = new Box()
    const ws = new Workspace(
      { '/repo': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: {
          commands: {
            deny: [
              { reason: 'no deletes', commands: ['rm'] },
              { reason: 'sealed', commands: ['cat'], paths: ['/repo/secret*'] },
              { reason: 'no pushes', commands: ['git push'] },
            ],
          },
          paths: { hide: [] },
        },
        runtimes: [box, 'vfs'],
      },
    )
    open.push(ws)
    ws.registerCli('git', cliSpecFor('git'))
    const unread = (raw: string) =>
      `policy denied: cannot read ${raw} before the runtime expands it\n`
    expect(await line(ws, 'rm /repo/x')).toEqual([126, '', 'rm: policy denied: no deletes\n'])
    expect(await line(ws, '$cmd /repo/x')).toEqual([126, '', '$cmd: ' + unread('$cmd')])
    expect(await line(ws, 'PAYLOAD=\'rm /repo/x\'; eval "$PAYLOAD"')).toEqual([
      126,
      '',
      '"$PAYLOAD": ' + unread('"$PAYLOAD"'),
    ])
    expect(await line(ws, "eval 'rm /repo/x'")).toEqual([
      126,
      '',
      'rm: policy denied: no deletes\n',
    ])
    expect(await line(ws, 'cat "$f"')).toEqual([126, '', 'cat: ' + unread('"$f"')])
    expect(await line(ws, 'git "$verb" origin')).toEqual([126, '', 'git: ' + unread('"$verb"')])
    expect(await line(ws, 'ls /repo | xargs rm')).toEqual([
      126,
      '',
      'rm: policy denied: no deletes\n',
    ])
    expect(await line(ws, 'ls /repo | xargs cat')).toEqual([
      126,
      '',
      'cat: policy denied: runs on operands the gate cannot read\n',
    ])
    expect(await line(ws, 'source /repo/env.sh')).toEqual([
      126,
      '',
      'source: policy denied: runs lines the gate cannot read\n',
    ])
    expect(await line(ws, "sh -c 'timeout 5 rm /repo/x'")).toEqual([
      126,
      '',
      'rm: policy denied: no deletes\n',
    ])
    expect(box.lines).toEqual([])
    // Literal words, and dynamic ones no rule reads, reach the runtime.
    const passing = [
      'echo "$HOME" $(date)',
      'git status',
      "'cat' /repo/a",
      'ls | xargs echo',
      'command -v rm',
    ]
    for (const text of passing) expect((await line(ws, text))[0]).toBe(0)
    expect(box.lines).toEqual(passing)
  })

  it('a bare listing in a ruled directory is refused', async () => {
    // `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the
    // working directory: the executor injects that operand after the
    // gate, so the gate supplies it itself, typed as `.`.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/repo': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: {
          commands: {
            deny: [{ reason: 'sealed', commands: ['ls', 'find', 'grep'], paths: ['/repo/sealed'] }],
          },
          paths: { hide: [] },
        },
      },
    )
    open.push(ws)
    await ws.execute('mkdir -p /repo/sealed && echo x > /repo/sealed/f')
    expect(await line(ws, 'ls /repo/sealed')).toEqual([1, '', 'ls: /repo/sealed: sealed\n'])
    expect(await line(ws, 'cd /repo/sealed && ls')).toEqual([1, '', 'ls: .: sealed\n'])
    expect(await line(ws, 'cd /repo/sealed && find -name f')).toEqual([1, '', 'find: .: sealed\n'])
    expect(await line(ws, 'cd /repo/sealed && grep -r x')).toEqual([
      1,
      '',
      'grep: /repo/sealed: sealed\n',
    ])
    // With an operand, or without the recursion that reads the
    // directory, nothing is implied.
    expect(await line(ws, 'cd /repo/sealed && ls /repo')).toEqual([0, 'sealed\n', ''])
    expect(await line(ws, 'cd /repo/sealed && echo x | grep x')).toEqual([0, 'x\n', ''])
  })
})

/** A runtime that takes every line raw, recording what reached it. */
class Box extends Runtime implements LineExecutor {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'box'
  lines: string[] = []

  constructor() {
    super({ captures: ['*'] })
  }

  runLine(
    line: string,
    _stdin: Uint8Array | null,
    _env: Record<string, string>,
    _cwd: string,
  ): Promise<RunResult> {
    this.lines.push(line)
    return Promise.resolve({ stdout: ENC.encode(`box:${line}`), stderr: null, exitCode: 0 })
  }
}

describe('ask end to end', () => {
  // Through the document parser, as the YAML door reads it: a bare
  // string under `ask` is one pattern with the default reason.
  const ASK_DOC = parseWorkspacePermissions({
    commands: {
      ask: [{ reason: 'sign-off', commands: ['rm'] }, 'head'],
      deny: [{ reason: 'no deletes in the repo', commands: ['rm'], paths: ['/repo/*'] }],
    },
  })

  // A coded condition that asks: every wc line.
  class AskWc implements Policy {
    preCommand(ctx: CommandContext): Action | null {
      if (ctx.command === 'wc') return { kind: 'ask', reason: 'looks risky' }
      return null
    }
  }

  async function askWs(options: { approver?: CallbackApprover } = {}): Promise<Workspace> {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/repo': new RAMResource(), '/scratch': new RAMResource() },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        permissions: ASK_DOC,
        policies: [new AskWc()],
        ...(options.approver !== undefined ? { approver: options.approver } : {}),
      },
    )
    open.push(ws)
    return ws
  }

  async function line(
    ws: Workspace,
    text: string,
    sessionId?: string,
  ): Promise<[number, string, string]> {
    const r = await ws.execute(text, sessionId === undefined ? {} : { sessionId })
    return [r.exitCode, stdoutStr(r), stderrStr(r)]
  }

  // The one request a step expects on the door; a missing one is the
  // test's failure, not a type to thread through.
  function pendingRequest(ws: Workspace, command?: string): ApprovalRequest {
    const found = ws.approvals.list().find((r) => command === undefined || r.command === command)
    if (found === undefined) throw new Error(`no pending approval for ${command ?? 'any command'}`)
    return found
  }

  it('an asked line is refused until the host answers', async () => {
    const ws = await askWs()
    await ws.execute('mkdir -p /repo/d && touch /repo/d/x /scratch/z')
    // Asked: 126 in the requires-approval voice, quoting an id; the
    // request is on ws.approvals with what was asked; a retry quotes the
    // same id and adds nothing.
    const [code, , err] = await line(ws, 'rm /scratch/z')
    expect(code).toBe(126)
    const request = pendingRequest(ws)
    expect(err).toBe(`rm: requires approval: sign-off (approval ${request.id})\n`)
    expect([request.command, request.argv, request.cwd, request.paths]).toEqual([
      'rm',
      ['/scratch/z'],
      '/',
      ['/scratch/z'],
    ])
    expect(request.sessionId).toBe(ws.sessionManager.defaultId)
    expect(await line(ws, 'rm /scratch/z')).toEqual([126, '', err])
    expect(ws.approvals.list()).toHaveLength(1)
    // The request names the agent of the call that asked, not the
    // workspace's constructor agent, so a shared workspace attributes
    // an approval to whoever raised it.
    expect(request.agentId).toBe('')
    const byBob = await ws.execute('rm /scratch/z2', { agentId: 'bob' })
    expect(byBob.exitCode).toBe(126)
    expect(ws.approvals.list().map((r) => r.agentId)).toEqual(['', 'bob'])
    // The agent rides with the execution, not the workspace: a line
    // asked through a nested eval keeps its caller's, and two lines in
    // flight at once keep their own.
    const nested = await ws.execute('echo $(rm /scratch/z3)', { agentId: 'carol' })
    expect(nested.exitCode).toBe(0)
    await Promise.all([
      ws.execute('rm /scratch/z4', { agentId: 'dan' }),
      ws.execute("eval 'rm /scratch/z5'", { agentId: 'eve' }),
    ])
    const byAgent = Object.fromEntries(
      ws.approvals.list().map((r) => [[r.command, ...r.argv].join(' '), r.agentId]),
    )
    expect(byAgent).toEqual({
      'rm /scratch/z': '',
      'rm /scratch/z2': 'bob',
      'rm /scratch/z3': 'carol',
      'rm /scratch/z4': 'dan',
      'rm /scratch/z5': 'eve',
    })
    for (const r of ws.approvals.list()) {
      if (r.agentId !== '' && r.agentId !== 'bob') await ws.approvals.deny(r.id)
    }
    const bobs = ws.approvals.list().find((r) => r.agentId === 'bob')
    if (bobs === undefined) throw new Error('no request from bob')
    await ws.approvals.deny(bobs.id)
    // Granted once: the exact retry passes, and the next one asks.
    await ws.approvals.grant(request.id)
    expect(ws.approvals.list()).toEqual([])
    expect((await line(ws, 'rm /scratch/z'))[0]).toBe(0)
    expect((await line(ws, 'cat /scratch/z'))[0]).toBe(1)
    const again = await line(ws, 'rm /scratch/z')
    expect(again[0]).toBe(126)
    expect(again[2]).toContain('requires approval')
    // A bare pattern asks with the default reason.
    const asked = await line(ws, 'head /repo/d/x')
    expect(asked[0]).toBe(126)
    expect(asked[2].startsWith('head: requires approval: no standing approval')).toBe(true)
    // Denied: the retry is refused once in the deny voice, then the
    // question is open again.
    await ws.approvals.deny(pendingRequest(ws, 'head').id)
    expect(await line(ws, 'head /repo/d/x')).toEqual([
      126,
      '',
      'head: policy denied: no standing approval\n',
    ])
    const reasked = await line(ws, 'head /repo/d/x')
    expect(reasked[0]).toBe(126)
    expect(reasked[2]).toContain('requires approval')
  })

  it('a session grant covers the rule and a deny is never re-opened', async () => {
    const ws = await askWs()
    await ws.execute('mkdir -p /repo/d && touch /repo/d/x /scratch/y /scratch/z')
    expect((await line(ws, 'rm /scratch/y'))[0]).toBe(126)
    await ws.approvals.grant(pendingRequest(ws).id, 'session')
    // Every rm line passes now, in any directory of the session ...
    expect((await line(ws, 'rm /scratch/y'))[0]).toBe(0)
    expect((await line(ws, 'cd /scratch && rm z'))[0]).toBe(0)
    // ... except where a deny rule speaks: the deny arm runs before the
    // ask arm, so no grant can re-open it.
    expect(await line(ws, 'cd /repo/d && rm x')).toEqual([1, '', 'rm: x: no deletes in the repo\n'])
    // The grant is session state: on the record, and not another
    // session's.
    const record = ws.sessionManager.get(ws.sessionManager.defaultId).toJSON() as {
      grants: { decision: string }[]
    }
    expect(record.grants[0]?.decision).toBe('allow_session')
    ws.createSession('other')
    await ws.execute('touch /scratch/w', { sessionId: 'other' })
    const other = await line(ws, 'rm /scratch/w', 'other')
    expect(other[0]).toBe(126)
    expect(other[2]).toContain('requires approval')
  })

  it('a coded ask routes to the same door', async () => {
    const ws = await askWs()
    await ws.execute('touch /scratch/z')
    const [code, , err] = await line(ws, 'wc -c /scratch/z')
    expect(code).toBe(126)
    const request = pendingRequest(ws)
    expect(err).toBe(`wc: requires approval: looks risky (approval ${request.id})\n`)
    // The synthesized rule names the program, so a session grant covers
    // every wc line.
    expect(request.rule).toEqual({ reason: 'looks risky', commands: ['wc'] })
    await ws.approvals.grant(request.id, 'session')
    expect(await line(ws, 'wc -c /scratch/z')).toEqual([0, '0 /scratch/z\n', ''])
    expect(await line(ws, 'wc -l /scratch/z')).toEqual([0, '0 /scratch/z\n', ''])
  })

  it('a grant is consumed through a fork', async () => {
    const ws = await askWs()
    await ws.execute('touch /scratch/z')
    expect((await line(ws, 'rm /scratch/z'))[0]).toBe(126)
    await ws.approvals.grant(pendingRequest(ws).id)
    // execute({env}) runs the line in a fork of the session: the once
    // grant is read and consumed through the manager, so the fork
    // spends it for the session it forked from.
    const forked = await ws.execute('rm /scratch/z', { env: { X: '1' } })
    expect(forked.exitCode).toBe(0)
    const again = await line(ws, 'rm /scratch/z')
    expect(again[0]).toBe(126)
    expect(again[2]).toContain('requires approval')
  })

  it('a blocking approver answers inside the line', async () => {
    const allowOnce = (_r: ApprovalRequest): Promise<ApprovalDecision> =>
      Promise.resolve('allow_once')
    const denyIt = (_r: ApprovalRequest): Promise<ApprovalDecision> => Promise.resolve('deny')
    const yes = await askWs({ approver: new CallbackApprover(allowOnce) })
    await yes.execute('touch /scratch/z')
    expect((await line(yes, 'rm /scratch/z'))[0]).toBe(0)
    expect(yes.approvals.list()).toEqual([])
    const no = await askWs({ approver: new CallbackApprover(denyIt) })
    await no.execute('touch /scratch/z')
    expect(await line(no, 'rm /scratch/z')).toEqual([126, '', 'rm: policy denied: sign-off\n'])
    expect((await line(no, 'cat /scratch/z'))[0]).toBe(0)
  })
})
