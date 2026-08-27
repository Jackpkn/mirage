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
import { HfHubError, apiUrl, errorOf, hubHeaders, resolveUrl } from './client.ts'

describe('hubHeaders', () => {
  it('omits Authorization without a token', () => {
    expect(hubHeaders(undefined)).toEqual({ Accept: 'application/json' })
    expect(hubHeaders('')).toEqual({ Accept: 'application/json' })
  })

  it('carries a bearer token', () => {
    expect(hubHeaders('tok').Authorization).toBe('Bearer tok')
  })
})

describe('apiUrl', () => {
  it.each([
    ['model', 'https://huggingface.co/api/models/a/b/refs'],
    ['dataset', 'https://huggingface.co/api/datasets/a/b/refs'],
    ['space', 'https://huggingface.co/api/spaces/a/b/refs'],
  ])('pluralizes %s', (repoType, expected) => {
    expect(apiUrl('https://huggingface.co', repoType, 'a/b', '/refs')).toBe(expected)
  })
})

describe('resolveUrl', () => {
  it.each([
    ['model', 'https://huggingface.co/a/b/resolve/main/f.json'],
    ['dataset', 'https://huggingface.co/datasets/a/b/resolve/main/f.json'],
    ['space', 'https://huggingface.co/spaces/a/b/resolve/main/f.json'],
  ])('puts a %s at its own segment', (repoType, expected) => {
    // The content host is not the API host's table: a model's files hang off
    // the bare repo id while a dataset's and a space's sit under their own
    // segment, so reusing the API's plural here 404s every model read.
    expect(resolveUrl('https://huggingface.co', repoType, 'a/b', 'main', 'f.json')).toBe(expected)
  })

  it('percent-encodes each path segment', () => {
    const url = resolveUrl('https://huggingface.co', 'model', 'a/b', 'main', 'dir/a file#1.txt')
    expect(url.endsWith('/resolve/main/dir/a%20file%231.txt')).toBe(true)
  })

  it('keeps slashes between segments', () => {
    const url = resolveUrl('https://huggingface.co', 'model', 'a/b', 'main', 'deep/nested/f.txt')
    expect(url.endsWith('/resolve/main/deep/nested/f.txt')).toBe(true)
  })
})

describe('errorOf', () => {
  it('prefers the Hub error header', () => {
    const response = new Response('{"error":"whatever"}', {
      status: 404,
      headers: { 'X-Error-Message': 'Entry not found' },
    })
    const err = errorOf(response, '{"error":"whatever"}')
    expect(err).toBeInstanceOf(HfHubError)
    expect(err.message).toBe('Entry not found')
    expect((err as HfHubError).status).toBe(404)
  })

  it('falls back to the body', () => {
    const err = errorOf(new Response('boom', { status: 500 }), '  boom  ')
    expect(err.message).toBe('boom')
    expect((err as HfHubError).status).toBe(500)
  })
})
