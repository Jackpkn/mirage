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

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { Option } from '../../commands/spec/types.ts'
import { CLISpec, type CLIVerbFn } from '../../commands/cli/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import type { Runtime } from '../../runtime/base.ts'
import { VFSRuntime } from '../../runtime/table.ts'
import { registerSecrets } from '../../secrets/registry.ts'
import type { EnvEntries, ResolvedSecret } from '../../secrets/types.ts'
import { VarAttr } from '../../shell/variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { MountMode } from '../../types.ts'
import type { Action, CommandContext, Policy } from '../../policy/index.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { guestBound } from './fill.ts'
import { Workspace } from './workspace.ts'

const FakeConfig = z.strictObject({})
type FakeConfig = z.infer<typeof FakeConfig>

function countingSource(fields: Record<string, string>): {
  calls: string[]
  fetch: (config: FakeConfig, ref: string) => Promise<ResolvedSecret>
} {
  const calls: string[] = []
  return {
    calls,
    fetch: (_config, ref) => {
      calls.push(ref)
      return Promise.resolve({ fields: { ...fields } })
    },
  }
}

class DenyNamed implements Policy {
  private readonly name: string

  constructor(name: string) {
    this.name = name
  }

  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command !== this.name) return null
    return { kind: 'deny', reason: `${this.name} is off`, scope: 'command' }
  }
}

async function makeWs(env: EnvEntries | undefined, policies?: Policy[]): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      ...(env !== undefined ? { env } : {}),
      ...(policies !== undefined ? { policies } : {}),
    },
  )
}

function envCliSpec(): CLISpec {
  const leaf: CLIVerbFn = () => null
  return new CLISpec({
    name: 'mycli',
    options: [new Option({ long: '--token', type: 'str', env: 'CLI_ROOT' })],
    subcommands: [
      new CLISpec({
        name: 'alpha',
        fn: leaf,
        options: [new Option({ long: '--a', type: 'str', env: 'CLI_ALPHA' })],
      }),
      new CLISpec({
        name: 'beta',
        fn: leaf,
        options: [new Option({ long: '--b', type: 'str', env: 'CLI_BETA' })],
      }),
    ],
  })
}

describe('fillEnv through execute', () => {
  it('lazy fetches only when referenced and only once', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-lazy', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-lazy', ref: 'r' } })
    try {
      expect((await ws.execute('echo hi')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a whole-env command fetches an unspelled name', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-whole', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-whole', ref: 'r' } })
    try {
      expect((await ws.execute('ls /')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('env'))).toContain('TOKEN=t0')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('eager joins every line while a lazy sibling waits', async () => {
    const { calls, fetch } = countingSource({ E: 'ev', L: 'lv' })
    registerSecrets('fake-eager', FakeConfig, fetch)
    const ws = await makeWs({
      E: { from: 'fake-eager', ref: 're', fetch: 'eager' },
      L: { from: 'fake-eager', ref: 'rl' },
    })
    try {
      expect((await ws.execute('echo hi')).exitCode).toBe(0)
      expect(calls).toEqual(['re'])
      const session = ws.getSession(ws.defaultSessionId)
      expect(session.vars.E?.value).toBe('ev')
      expect(session.vars.L?.value).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('two names off one secret is one fetch', async () => {
    const { calls, fetch } = countingSource({ user: 'u', pass: 'p' })
    registerSecrets('fake-group', FakeConfig, fetch)
    const ws = await makeWs({
      DB_USER: { from: 'fake-group', ref: 'db', key: 'user' },
      DB_PASS: { from: 'fake-group', ref: 'db', key: 'pass' },
    })
    try {
      expect(stdoutStr(await ws.execute('echo $DB_USER:$DB_PASS'))).toBe('u:p\n')
      expect(calls).toEqual(['db'])
    } finally {
      await ws.close()
    }
  })

  it('key defaults to the variable name', async () => {
    const { fetch } = countingSource({ API: 'v' })
    registerSecrets('fake-key', FakeConfig, fetch)
    const ws = await makeWs({ API: { from: 'fake-key', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('echo $API'))).toBe('v\n')
    } finally {
      await ws.close()
    }
  })

  it('a missing key names both sides', async () => {
    const { fetch } = countingSource({ a: '1', b: '2' })
    registerSecrets('fake-miss', FakeConfig, fetch)
    const ws = await makeWs({ T: { from: 'fake-miss', ref: 'r', key: 'c' } })
    try {
      const io = await ws.execute('echo $T')
      expect(io.exitCode).toBe(1)
      const err = stderrStr(io)
      expect(err).toContain('T')
      expect(err).toContain("'c'")
      expect(err).toContain('a, b')
    } finally {
      await ws.close()
    }
  })

  it("a per-session env is that session's alone", async () => {
    const { calls, fetch } = countingSource({ S: 'sv' })
    registerSecrets('fake-session', FakeConfig, fetch)
    const ws = await makeWs(undefined)
    try {
      ws.sessionManager.create('s2', { env: { S: { from: 'fake-session', ref: 'r' } } })
      const io = await ws.execute('echo $S', { sessionId: 's2' })
      expect(stdoutStr(io)).toBe('sv\n')
      expect(calls).toEqual(['r'])
      expect('S' in ws.getSession(ws.defaultSessionId).vars).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('a readonly preset refuses with bash wording', async () => {
    const ws = await makeWs({ EDITOR: { value: 'vi', readonly: true } })
    try {
      let io = await ws.execute('EDITOR=x')
      expect(io.exitCode).toBe(1)
      expect(stderrStr(io)).toBe('bash: EDITOR: readonly variable\n')
      io = await ws.execute('unset EDITOR')
      expect(io.exitCode).toBe(1)
      expect(stderrStr(io)).toBe('bash: unset: EDITOR: cannot unset: readonly variable\n')
      expect(stdoutStr(await ws.execute('echo $EDITOR'))).toBe('vi\n')
    } finally {
      await ws.close()
    }
  })

  it('export -p renders an unfetched managed name unset', async () => {
    // Written straight into the session (no env block), so the fill
    // pass is off and the renderer meets the third state itself.
    const ws = await makeWs(undefined)
    try {
      const session = ws.getSession(ws.defaultSessionId)
      session.vars.T = {
        value: null,
        attrs: new Set([VarAttr.Export]),
        managed: { source: 'fake', ref: 'r', key: 'T', eager: false },
      }
      expect(stdoutStr(await ws.execute('export -p'))).toContain('declare -x T\n')
    } finally {
      await ws.close()
    }
  })

  it('a command substitution fetches through the inner fill', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-cmdsub', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-cmdsub', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('x=$(echo $TOKEN); echo $x'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a subshell export detaches only the fork', async () => {
    const { fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-fork', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-fork', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('(export TOKEN=y; echo $TOKEN)'))).toBe('y\n')
      expect(ws.getSession(ws.defaultSessionId).vars.TOKEN?.managed).not.toBeUndefined()
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
    } finally {
      await ws.close()
    }
  })

  it('a write detaches, the next read is session-served, the value serializes', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-write', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-write', ref: 'r' } })
    try {
      expect((await ws.execute('export TOKEN=mine')).exitCode).toBe(0)
      const afterWrite = calls.length
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('mine\n')
      expect(calls.length).toBe(afterWrite)
      const data = ws.getSession(ws.defaultSessionId).toJSON()
      expect((data.env as Record<string, string>).TOKEN).toBe('mine')
      expect('managed' in data).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('a dead source fails only the command that needs it', async () => {
    registerSecrets('fake-dead', FakeConfig, () => Promise.reject(new Error('connection refused')))
    const ws = await makeWs({ TOKEN: { from: 'fake-dead', ref: 'r' } })
    try {
      const io = await ws.execute('echo $TOKEN')
      expect(io.exitCode).toBe(1)
      // The source's own words stay host-side: the agent learns the
      // variable and the source name, never the exception text.
      expect(stderrStr(io)).toBe('TOKEN: cannot fetch from fake-dead\n')
      expect((await ws.execute('ls /')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('an unknown source fails at construction', async () => {
    await expect(makeWs({ T: { from: 'nope-never', ref: 'r' } })).rejects.toThrowError(
      /unknown secrets source/,
    )
  })

  it('a mutating export detaches without fetching', async () => {
    registerSecrets('fake-detach', FakeConfig, () => Promise.reject(new Error('sealed')))
    const ws = await makeWs({ TOKEN: { from: 'fake-detach', ref: 'r' } })
    try {
      expect((await ws.execute('export TOKEN=local')).exitCode).toBe(0)
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('local\n')
    } finally {
      await ws.close()
    }
  })

  it('mutating forms do not render the environment', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-mutate', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-mutate', ref: 'r' } })
    try {
      for (const line of ['set -u', 'set +u', 'declare -x OTHER=1', 'export OTHER=2']) {
        await ws.execute(line)
      }
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('declare -p TOKEN'))).toContain('t0')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('printenv of the name fetches it', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-printenv', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-printenv', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('printenv TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a hidden managed name never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-hidden', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-hidden', ref: 'r', fetch: 'eager' } })
    try {
      const session = ws.getSession(ws.defaultSessionId)
      session.hiddenVars = { names: ['TOKEN'] }
      const io = await ws.execute('env')
      expect(io.exitCode).toBe(0)
      expect(stdoutStr(io)).not.toContain('TOKEN')
      expect(stdoutStr(await ws.execute('echo [$TOKEN]'))).toBe('[]\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a stored function body fills across lines', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-fn', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-fn', ref: 'r' } })
    try {
      expect((await ws.execute('f() { echo "t:$TOKEN"; }')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('f'))).toBe('t:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a function calling a function fills transitively', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-fn2', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-fn2', ref: 'r' } })
    try {
      await ws.execute('inner() { echo "i:$TOKEN"; }')
      await ws.execute('outer() { inner; }')
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('outer'))).toBe('i:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an indirect expansion fetches the target', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-indirect', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-indirect', ref: 'r' } })
    try {
      expect((await ws.execute('name=TOKEN')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo ${!name}'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a prior-line nameref fetches its target', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-nameref', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-nameref', ref: 'r' } })
    try {
      const session = ws.getSession(ws.defaultSessionId)
      // Written straight into the session so the declaring line's own
      // opaque-read fetch cannot mask the deref path.
      session.vars.r2 = { value: 'TOKEN', attrs: new Set([VarAttr.Nameref]) }
      expect(stdoutStr(await ws.execute('echo $r2'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an alias body fills on invocation', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-alias', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-alias', ref: 'r' } })
    try {
      expect((await ws.execute('shopt -s expand_aliases')).exitCode).toBe(0)
      expect((await ws.execute('alias show=\'echo "a:$TOKEN"\'')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('show'))).toBe('a:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an alias never fetches while expansion is off', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-alias-off', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-alias-off', ref: 'r' } })
    try {
      await ws.execute("alias show='echo $TOKEN'")
      expect((await ws.execute('show')).exitCode).not.toBe(0)
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('an invocation before a redefinition fills the stored body', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-order', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-order', ref: 'r' } })
    try {
      expect((await ws.execute('f() { echo "t:$TOKEN"; }')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('f; f() { :; }'))).toBe('t:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a dynamic head fetches everything pending', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-dyn', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-dyn', ref: 'r' } })
    try {
      expect((await ws.execute('h=echo')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('$h hi'))).toBe('hi\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a copy carries the env template to new sessions', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-copy', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-copy', ref: 'r' }, MODE: 'prod' })
    try {
      const twin = await ws.copy()
      try {
        twin.createSession('later')
        const io = await twin.execute('echo $MODE:$TOKEN', { sessionId: 'later' })
        expect(stdoutStr(io)).toBe('prod:t0\n')
        expect(calls).toEqual(['r'])
      } finally {
        await twin.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('a denied literal line never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-denied', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-denied', ref: 'r' } }, [
      new DenyNamed('printenv'),
    ])
    try {
      const io = await ws.execute('printenv TOKEN')
      expect(io.exitCode).toBe(126)
      expect(stderrStr(io)).toContain('printenv is off')
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a dynamic-word deny fetches before the value gate', async () => {
    // The pre-pass reads a line's text; a command carrying a word only
    // expansion can produce is judged at the per-command gate, which
    // reads values. Expansion is what consumes the fetched value, so
    // for such a line the fetch precedes the verdict, the same way the
    // line's earlier commands would already have run.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-dynamic', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-dynamic', ref: 'r' } }, [new DenyNamed('echo')])
    try {
      const io = await ws.execute('echo $TOKEN')
      expect(io.exitCode).toBe(126)
      expect(stderrStr(io)).toContain('echo is off')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a cli fetches only the invoked verb path', async () => {
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0', CLI_ALPHA: 'a0', CLI_BETA: 'b0' })
    registerSecrets('fake-cli-path', FakeConfig, fetch)
    const ws = await makeWs({
      CLI_ROOT: { from: 'fake-cli-path', ref: 'root' },
      CLI_ALPHA: { from: 'fake-cli-path', ref: 'alpha' },
      CLI_BETA: { from: 'fake-cli-path', ref: 'beta' },
    })
    try {
      ws.registerCli('mycli', envCliSpec())
      await ws.execute('mycli alpha')
      expect([...calls].sort()).toEqual(['alpha', 'root'])
    } finally {
      await ws.close()
    }
  })

  it('an alias-invoked cli fetches its env', async () => {
    // The alias value is a textual prefix, so the verb is unknowable
    // until dispatch appends the rest; the walk falls back to the
    // whole spec tree rather than reading "no verb selected".
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0', CLI_ALPHA: 'a0' })
    registerSecrets('fake-cli-alias', FakeConfig, fetch)
    const ws = await makeWs({
      CLI_ROOT: { from: 'fake-cli-alias', ref: 'root' },
      CLI_ALPHA: { from: 'fake-cli-alias', ref: 'alpha' },
    })
    try {
      ws.registerCli('mycli', envCliSpec())
      await ws.execute('shopt -s expand_aliases')
      await ws.execute("alias n='mycli'")
      expect(calls).toEqual([])
      await ws.execute('n alpha')
      expect(calls).toContain('alpha')
      expect(calls).toContain('root')
    } finally {
      await ws.close()
    }
  })

  it('a shadowed cli head does not fetch', async () => {
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0' })
    registerSecrets('fake-cli-shadow', FakeConfig, fetch)
    const ws = await makeWs({ CLI_ROOT: { from: 'fake-cli-shadow', ref: 'root' } })
    try {
      ws.registerCli('mycli', envCliSpec())
      await ws.execute('mycli() { echo shadowed; }')
      expect(stdoutStr(await ws.execute('mycli'))).toBe('shadowed\n')
      expect(calls).toEqual([])
      await ws.execute('unset -f mycli')
      await ws.execute('mycli')
      expect(calls).toEqual(['root'])
    } finally {
      await ws.close()
    }
  })
})

describe('guestBound', () => {
  it('a non-vfs binding on a line word counts; vfs does not', async () => {
    const parser = await getTestParser()
    const node = parser.parse('python3 -c "print()"') as unknown as TSNodeLike
    const guest = { name: 'monty' } as unknown as Runtime
    expect(guestBound([node], null, { python3: guest })).toBe(true)
    expect(guestBound([node], null, { python3: new VFSRuntime() })).toBe(false)
    expect(guestBound([node], null, { other: guest })).toBe(false)
    expect(guestBound([node], null, { '*': guest })).toBe(true)
  })

  it('a decision replaces the static table', async () => {
    const parser = await getTestParser()
    const node = parser.parse('echo hi') as unknown as TSNodeLike
    const guest = { name: 'monty' } as unknown as Runtime
    const decision = { bindings: { echo: guest }, fallback: null } as never
    expect(guestBound([node], decision, {})).toBe(true)
    expect(guestBound([node], null, { echo: null })).toBe(false)
  })
})
