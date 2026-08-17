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

export interface RetryPolicy {
  /** Response statuses worth retrying. */
  readonly statuses: ReadonlySet<number>
  /** Retries allowed after the first attempt. */
  readonly maxRetries: number
  /** Cap for the exponential-backoff fallback. */
  readonly maxBackoff: number
  /**
   * Where the wait between attempts comes from: 'header' reads Retry-After
   * and falls back to exponential backoff (Graph's convention); 'body'
   * reads a JSON `retry_after` field and falls back to 1s (Discord's).
   */
  readonly delaySource: 'header' | 'body'
}

export const NO_RETRY: RetryPolicy = {
  statuses: new Set(),
  maxRetries: 0,
  maxBackoff: 30,
  delaySource: 'header',
}

/**
 * Maps a >= 400 response and its body text to the backend's own error;
 * the kit never invents an error shape.
 */
export type ErrorOf = (response: Response, body: string) => Error

export interface ApiRequestOptions {
  errorOf: ErrorOf
  /** Request headers, already merged by the caller. */
  headers?: Record<string, string>
  params?: Record<string, string | number | boolean>
  /** JSON request body; absent sends no body, so a caller that means "send
   * an empty object" passes `{}` explicitly. */
  json?: unknown
  retry?: RetryPolicy
  /** The fetch to use, so transports keep their injection seam. */
  fetchFn?: typeof fetch
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

function headerDelay(response: Response, attempt: number, retry: RetryPolicy): number {
  const value = response.headers.get('Retry-After')
  if (value !== null) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Math.min(2 ** attempt, retry.maxBackoff)
}

async function bodyDelay(response: Response): Promise<number> {
  const data = (await response.json().catch(() => ({}))) as { retry_after?: unknown }
  return typeof data.retry_after === 'number' ? data.retry_after : 1
}

async function retryDelay(
  response: Response,
  attempt: number,
  retry: RetryPolicy,
): Promise<number> {
  if (retry.delaySource === 'body') return bodyDelay(response)
  return headerDelay(response, attempt, retry)
}

/**
 * One round-trip against a JSON HTTP API, with retry and error mapping.
 * Returns the parsed body, or null when the body is empty (a 204).
 */
export async function apiRequest(
  method: string,
  url: string,
  options: ApiRequestOptions,
): Promise<unknown> {
  const doFetch = options.fetchFn ?? fetch
  const target = new URL(url)
  for (const [name, value] of Object.entries(options.params ?? {})) {
    target.searchParams.set(name, String(value))
  }
  const retry = options.retry ?? NO_RETRY
  let attempt = 0
  for (;;) {
    const init: RequestInit = { method, headers: { ...options.headers } }
    if (options.json !== undefined) init.body = JSON.stringify(options.json)
    const response = await doFetch(target.toString(), init)
    if (retry.statuses.has(response.status) && attempt < retry.maxRetries) {
      await sleep(await retryDelay(response, attempt, retry))
      attempt += 1
      continue
    }
    const text = await response.text()
    if (response.status >= 400) throw options.errorOf(response, text)
    return text === '' ? null : (JSON.parse(text) as unknown)
  }
}
