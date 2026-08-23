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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFile, fileBlobName } from './files.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'

const BODY = '0123456789'

function respond(status: number, body: string): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      statusText: String(status),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
      text: () => Promise.resolve(body),
    }),
  ) as unknown as typeof globalThis.fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('downloadFile', () => {
  it('sends the window as a Range header', async () => {
    const fetch = respond(206, '234')
    vi.stubGlobal('fetch', fetch)
    await downloadFile('https://cdn.example/a.csv', 2, 3)
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).Range).toBe('bytes=2-4')
  })

  // A CDN may legally ignore Range and answer 200 with the whole file. Before
  // this was handled the caller got every byte for what it asked to be a
  // window, which over FUSE is a read far longer than the buffer it was given.
  it('slices locally when the server ignores the range and answers 200', async () => {
    vi.stubGlobal('fetch', respond(200, BODY))
    const out = await downloadFile('https://cdn.example/a.csv', 2, 3)
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  it('trusts a 206 body as already the window', async () => {
    vi.stubGlobal('fetch', respond(206, '234'))
    const out = await downloadFile('https://cdn.example/a.csv', 2, 3)
    expect(new TextDecoder().decode(out)).toBe('234')
  })

  it('reads the whole file when no window is asked for', async () => {
    const fetch = respond(200, BODY)
    vi.stubGlobal('fetch', fetch)
    const out = await downloadFile('https://cdn.example/a.csv')
    expect(new TextDecoder().decode(out)).toBe(BODY)
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).Range).toBeUndefined()
  })

  it('throws on a failed response', async () => {
    vi.stubGlobal('fetch', respond(404, ''))
    await expect(downloadFile('https://cdn.example/gone.csv')).rejects.toThrow(/404/)
  })
})

describe('fileBlobName', () => {
  const NAME = '会議'.repeat(100)

  it('fits a long attachment name inside NAME_MAX, keeping id and extension', () => {
    const name = fileBlobName({ id: '1234567890123456789', filename: `${NAME}.txt` })

    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name.endsWith('1234567890123456789.txt')).toBe(true)
    expect(name).not.toContain('\uFFFD')
  })

  it('fits one with no extension', () => {
    const name = fileBlobName({ id: '1234567890123456789', filename: NAME })

    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name.endsWith('1234567890123456789')).toBe(true)
  })
})
