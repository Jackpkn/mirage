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

import { describe, expect, it, vi } from 'vitest'
import { NO_RETRY, apiRequest, type RetryPolicy } from './client.ts'

const TARGET = 'https://api.test/v1/thing'

class Boom extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`boom ${String(status)}`)
  }
}

function errorOf(response: Response, body: string): Error {
  return new Boom(response.status, body)
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('apiRequest', () => {
  it('returns the parsed body', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ ok: true })))
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })
    expect(out).toEqual({ ok: true })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('an empty body is null', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    expect(await apiRequest('PUT', TARGET, { errorOf, fetchFn: fakeFetch })).toBeNull()
  })

  it('params reach the query string and the json body is serialized', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})))
    await apiRequest('POST', TARGET, {
      errorOf,
      fetchFn: fakeFetch,
      params: { a: 1, b: 'x' },
      json: { content: 'hi' },
      headers: { Authorization: 'Bearer t' },
    })
    const [url, init] = fakeFetch.mock.calls[0] ?? []
    expect(url).toBe(`${TARGET}?a=1&b=x`)
    expect(init?.body).toBe(JSON.stringify({ content: 'hi' }))
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer t')
  })

  it('an error status maps through the hook', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ message: 'nope' }, 404)),
    )
    const failure = apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })
    await expect(failure).rejects.toThrowError(Boom)
    await expect(failure).rejects.toMatchObject({
      status: 404,
      body: JSON.stringify({ message: 'nope' }),
    })
  })

  it('body-mode retry waits out the retryable statuses', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([429]),
      maxRetries: 2,
      delaySource: 'body',
    }
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ retry_after: 0.001 }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }))
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
    expect(out).toEqual({ ok: 1 })
    expect(fakeFetch).toHaveBeenCalledTimes(2)
  })

  it('exhausted retries map through the hook', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([429]),
      maxRetries: 2,
      delaySource: 'body',
    }
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ retry_after: 0.001 }, 429)),
    )
    await expect(
      apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry }),
    ).rejects.toThrowError(Boom)
    expect(fakeFetch).toHaveBeenCalledTimes(3)
  })

  it('header-mode retry honors Retry-After', async () => {
    const retry: RetryPolicy = { ...NO_RETRY, statuses: new Set([503]), maxRetries: 1 }
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { 'Retry-After': '0.001' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: 2 }))
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
    expect(out).toEqual({ ok: 2 })
  })

  it('does not retry by default', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ retry_after: 30 }, 429)),
    )
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })).rejects.toThrowError(
      Boom,
    )
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('propagates network errors without wrapping', async () => {
    const fakeFetch: typeof fetch = () => Promise.reject(new TypeError('network down'))
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })).rejects.toThrowError(
      TypeError,
    )
  })
})
