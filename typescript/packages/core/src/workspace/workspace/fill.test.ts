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
import type { CLIInstall } from '../cli/types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { cliEnvNames, guestBound } from './fill.ts'
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
    fetch: async (_config, ref) => {
      calls.push(ref)
      return { fields: { ...fields } }
    },
  }
}

async function makeWs(env: EnvEntries | undefined): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/': new RAMResource() },
    { mode: MountMode.WRITE, shellParser: parser, ...(env !== undefined ? { env } : {}) },
  )
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
    registerSecrets('fake-dead', FakeConfig, async () => {
      throw new Error('connection refused')
    })
    const ws = await makeWs({ TOKEN: { from: 'fake-dead', ref: 'r' } })
    try {
      const io = await ws.execute('echo $TOKEN')
      expect(io.exitCode).toBe(1)
      expect(stderrStr(io)).toBe('TOKEN: cannot fetch from fake-dead: connection refused\n')
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
})

describe('guestBound', () => {
  it('a non-vfs binding on a line word counts; vfs does not', async () => {
    const parser = await getTestParser()
    const node = parser.parse('python3 -c "print()"') as unknown as TSNodeLike
    const guest = { name: 'monty' } as unknown as Runtime
    expect(guestBound(node, null, { python3: guest })).toBe(true)
    expect(guestBound(node, null, { python3: new VFSRuntime() })).toBe(false)
    expect(guestBound(node, null, { other: guest })).toBe(false)
    expect(guestBound(node, null, { '*': guest })).toBe(true)
  })

  it('a decision replaces the static table', async () => {
    const parser = await getTestParser()
    const node = parser.parse('echo hi') as unknown as TSNodeLike
    const guest = { name: 'monty' } as unknown as Runtime
    const decision = { bindings: { echo: guest }, fallback: null } as never
    expect(guestBound(node, decision, {})).toBe(true)
    expect(guestBound(node, null, { echo: null })).toBe(false)
  })
})

describe('cliEnvNames', () => {
  it('reads env names off installed head words on the line', async () => {
    const parser = await getTestParser()
    const leaf: CLIVerbFn = () => null
    const spec = new CLISpec({
      name: 'ntn',
      subcommands: [
        new CLISpec({
          name: 'api',
          fn: leaf,
          options: [new Option({ long: '--notion-version', type: 'str', env: 'NOTION_VERSION' })],
        }),
      ],
    })
    const installs = new Map<string, CLIInstall>([['ntn', { name: 'ntn', spec, config: null }]])
    const onLine = parser.parse('ntn api /v1/users/me') as unknown as TSNodeLike
    expect(cliEnvNames(onLine, installs)).toEqual(new Set(['NOTION_VERSION']))
    const offLine = parser.parse('echo ntnish') as unknown as TSNodeLike
    expect(cliEnvNames(offLine, installs)).toEqual(new Set())
    expect(cliEnvNames(onLine, new Map())).toEqual(new Set())
  })
})
