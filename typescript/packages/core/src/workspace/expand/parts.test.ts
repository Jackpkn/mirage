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
import { IOResult } from '../../io/types.ts'
import { getParts } from '../../shell/helpers.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Session } from '../session/session.ts'
import { expandParts, expandWords } from './parts.ts'
import type { ExecuteFn } from './node.ts'

const ENC = new TextEncoder()

async function words(cmd: string, env: Record<string, string> = {}, stdout = '') {
  const parser = await getTestParser()
  const root = parser.parse(cmd)
  const parts = getParts(root.namedChildren[0] as never)
  const session = new Session({ sessionId: 't', cwd: '/', env })
  const executeFn: ExecuteFn = () => Promise.resolve(new IOResult({ stdout: ENC.encode(stdout) }))
  return { parts, session, executeFn, out: await expandWords(parts, session, executeFn) }
}

describe('expandWords globbability', () => {
  it.each([
    ['c /data/*.txt', '/data/*.txt', true],
    ["c '/data/*.txt'", '/data/*.txt', false],
    ['c "/data/*.txt"', '/data/*.txt', false],
    ['c /data/\\*.txt', '/data/*.txt', false],
    ["c '/data/?.txt'", '/data/?.txt', false],
    ["c '/data/[a].txt'", '/data/[a].txt', false],
    ["c $'/data/*.txt'", '/data/*.txt', false],
    ['c /data/a.txt', '/data/a.txt', false],
  ] as [string, string, boolean][])('%s', async (cmd, text, globbable) => {
    const { out } = await words(cmd)
    expect(out[1]?.text).toBe(text)
    expect(out[1]?.globbable).toBe(globbable)
  })

  it.each([
    ['c "/data/"*.txt', '/data/*.txt', true],
    ["c '/data/*'.txt", '/data/*.txt', false],
    ["c '/data/'x\\*.txt", '/data/x*.txt', false],
    ['c "/data/*"?.txt', '/data/*?.txt', true],
  ] as [string, string, boolean][])(
    'concatenation is live when any child is: %s',
    async (cmd, text, globbable) => {
      const { out } = await words(cmd)
      expect(out[1]?.text).toBe(text)
      expect(out[1]?.globbable).toBe(globbable)
    },
  )

  it('unquoted expansion value is live', async () => {
    const { out } = await words('c $p', { p: '/data/*.txt' })
    expect(out[1]).toEqual({ text: '/data/*.txt', globbable: true })
  })

  it('quoted expansion value is literal', async () => {
    const { out } = await words('c "$p"', { p: '/data/*.txt' })
    expect(out[1]).toEqual({ text: '/data/*.txt', globbable: false })
  })

  it('expansion without glob chars is not live', async () => {
    const { out } = await words('c $p', { p: '/data/a.txt' })
    expect(out[1]?.globbable).toBe(false)
  })

  it('command substitution words are live', async () => {
    const { out } = await words('c $(inner)', {}, '*.txt plain')
    expect(out.slice(1)).toEqual([
      { text: '*.txt', globbable: true },
      { text: 'plain', globbable: false },
    ])
  })

  it('brace quoted alternative stays literal', async () => {
    const { out } = await words("c {'*',x}")
    expect(out.slice(1)).toEqual([
      { text: '*', globbable: false },
      { text: 'x', globbable: false },
    ])
  })

  it('brace literal template glob is live', async () => {
    const { out } = await words('c {a,b}*')
    expect(out.slice(1)).toEqual([
      { text: 'a*', globbable: true },
      { text: 'b*', globbable: true },
    ])
  })

  it('brace unquoted expansion atom is live', async () => {
    const { out } = await words('c {$p,x}', { p: '*.txt' })
    expect(out.slice(1)).toEqual([
      { text: '*.txt', globbable: true },
      { text: 'x', globbable: false },
    ])
  })

  it('expandParts returns the same texts', async () => {
    const { parts, session, executeFn, out } = await words('c \'/data/*.txt\' "/data/"*.txt {a,b}*')
    const texts = await expandParts(parts, session, executeFn)
    expect(texts).toEqual(out.map((w) => w.text))
  })
})
