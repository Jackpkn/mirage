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

import { EnvVarSchema } from './config.ts'

describe('EnvVarSchema', () => {
  it('parses a literal entry with defaults', () => {
    const entry = EnvVarSchema.parse({ value: 'vi' })
    expect(entry.value).toBe('vi')
    expect(entry.readonly).toBe(false)
    expect(entry.export).toBe(true)
    expect(entry.from).toBeUndefined()
  })

  it('parses a managed entry with defaults', () => {
    const entry = EnvVarSchema.parse({ from: 'aws-sm', ref: 'prod/tokens' })
    expect(entry.from).toBe('aws-sm')
    expect(entry.ref).toBe('prod/tokens')
    expect(entry.key).toBeUndefined()
    expect(entry.fetch).toBe('lazy')
  })

  it("refuses 'value' and 'from' together", () => {
    expect(() => EnvVarSchema.parse({ value: 'v', from: 'env' })).toThrowError(/not both/)
  })

  it("needs 'value' or 'from'", () => {
    expect(() => EnvVarSchema.parse({})).toThrowError(/needs 'value' or 'from'/)
  })

  it('refuses readonly on a managed entry', () => {
    expect(() => EnvVarSchema.parse({ from: 'env', readonly: true })).toThrowError(/readonly/)
  })

  it('refuses export:false on a managed entry', () => {
    expect(() => EnvVarSchema.parse({ from: 'env', export: false })).toThrowError(/always exported/)
  })

  it('refuses managed knobs on a literal entry', () => {
    expect(() => EnvVarSchema.parse({ value: 'v', key: 'k' })).toThrowError(/managed entries/)
    expect(() => EnvVarSchema.parse({ value: 'v', fetch: 'eager' })).toThrowError(/managed entries/)
  })

  it('rejects an unknown key', () => {
    expect(() => EnvVarSchema.parse({ value: 'v', bogus: 1 })).toThrowError()
  })
})
