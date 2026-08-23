import { afterEach, describe, expect, it } from 'vitest'
import { ScriptSource } from '../runtime/policy/types.ts'
import { PathSpec } from '../types.ts'
import { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from './constants.ts'
import { ScriptPolicy, scriptAction, scriptContext } from './script.ts'
import type { CommandContext, ProfileScript } from './types.ts'

const JUDGE = `\
const c = ctx.command
const sealed = c.name === 'cat' && c.paths.some((p) => p.startsWith('/repo/sealed/'))
sealed ? { deny: 'sealed by ' + ctx.profile } : c.name === 'shred' ? { ask: 'sign-off' } : null
`

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: '',
    rawPath: virtual,
    resolved: true,
  })
}

function ctx(command = 'cat', sessionId = 's'): CommandContext {
  return {
    command,
    paths: [path('/repo/sealed/k')],
    operands: [path('/repo/sealed/k')],
    argv: ['/repo/sealed/k'],
    cwd: '/repo',
    registry: { isMountRoot: () => false },
    sessionId,
    agentId: 'agent-1',
    tokens: [command, '/repo/sealed/k'],
    program: [command],
  }
}

function entry(source = JUDGE, runtime = 'quickjs'): ProfileScript {
  return { profile: 'release', script: new ScriptSource(source, 'js'), runtime }
}

function policyOf(script: ProfileScript | null): ScriptPolicy {
  return new ScriptPolicy({ scriptOf: () => script }, () => ['/repo/', '/scratch/'])
}

const open: ScriptPolicy[] = []

function track(policy: ScriptPolicy): ScriptPolicy {
  open.push(policy)
  return policy
}

afterEach(async () => {
  for (const policy of open.splice(0)) await policy.close()
})

describe('scriptContext', () => {
  it('is the command context as data', () => {
    expect(scriptContext('release', ctx(), ['/repo/', '/scratch/'])).toEqual({
      profile: 'release',
      command: {
        name: 'cat',
        argv: ['/repo/sealed/k'],
        tokens: ['cat', '/repo/sealed/k'],
        program: ['cat'],
        paths: ['/repo/sealed/k'],
        operands: ['/repo/sealed/k'],
        tool: true,
        walks: false,
      },
      session: { id: 's', agent: 'agent-1', cwd: '/repo' },
      mounts: ['/repo/', '/scratch/'],
    })
  })
})

describe('scriptAction', () => {
  it.each([[null], ['allow']])('reads %j as no opinion', (value) => {
    expect(scriptAction(value)).toBeNull()
  })

  it('turns a deny answer into a whole-command deny', () => {
    expect(scriptAction({ deny: 'sealed' })).toEqual({ kind: 'deny', reason: 'sealed' })
  })

  it('takes an ask answer to the approval door', () => {
    const action = scriptAction({ ask: 'sign-off' })
    expect(action).toEqual({ kind: 'ask', reason: 'sign-off' })
  })

  it("gives the bare verbs the document's default reasons", () => {
    expect(scriptAction('deny')).toEqual({ kind: 'deny', reason: DEFAULT_DENY_REASON })
    expect(scriptAction('ask')).toEqual({ kind: 'ask', reason: DEFAULT_ASK_REASON })
  })

  it.each([
    [[1, 2]],
    [7],
    ['nope'],
    [{}],
    [{ deny: '' }],
    [{ deny: 3 }],
    [{ allow: true }],
    [{ deny: 'a', ask: 'b' }],
  ])('refuses %j', (value) => {
    expect(() => scriptAction(value)).toThrow(/must answer allow, deny or ask/)
  })
})

describe('ScriptPolicy', () => {
  it('does not judge a session without a script', async () => {
    const policy = track(policyOf(null))
    expect(await policy.preCommand(ctx())).toBeNull()
  })

  it('refuses a command with a deny it computed', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preCommand(ctx('cat'))).toEqual({
      kind: 'deny',
      reason: 'sealed by release',
    })
  })

  it('stays silent on a command the script allows', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preCommand(ctx('ls'))).toBeNull()
  })

  it('takes an ask it computed to the door', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preCommand(ctx('shred'))).toEqual({ kind: 'ask', reason: 'sign-off' })
  })

  it('fails closed when the script throws', async () => {
    // Silence on failure would run exactly the commands the script
    // existed to judge, so every failure arm refuses instead.
    const policy = track(policyOf(entry("(() => { throw new Error('boom') })()")))
    const action = await policy.preCommand(ctx())
    expect(action).toMatchObject({ kind: 'deny' })
    expect((action as { reason: string }).reason).toMatch(/profile 'release' script failed/)
  })

  it('fails closed on a wrong answer shape', async () => {
    const policy = track(policyOf(entry('[1, 2]')))
    const action = await policy.preCommand(ctx())
    expect((action as { reason: string }).reason).toMatch(/profile 'release' script must answer/)
  })

  it('fails closed on an engine it cannot build', async () => {
    const policy = track(policyOf(entry(JUDGE, 'ghost')))
    const action = await policy.preCommand(ctx())
    expect((action as { reason: string }).reason).toMatch(
      /profile 'release' script names runtime 'ghost'/,
    )
  })

  it('fails closed on an engine that cannot evaluate', async () => {
    const policy = track(policyOf(entry(JUDGE, 'vfs')))
    const action = await policy.preCommand(ctx())
    expect((action as { reason: string }).reason).toMatch(/cannot evaluate one/)
  })

  it('reuses one engine across commands and closes it', async () => {
    const policy = policyOf(entry())
    expect(await policy.preCommand(ctx('cat'))).not.toBeNull()
    expect(await policy.preCommand(ctx('ls'))).toBeNull()
    await policy.close()
  })
})
