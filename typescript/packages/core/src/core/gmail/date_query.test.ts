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
import { dateDirToGmailQuery, spanToGmailQuery } from './date_query.ts'

describe('dateDirToGmailQuery', () => {
  // Epoch seconds for midnight UTC, one second early on the lower bound.
  it.each([
    ['2026-05-03', 'after:1777766399 before:1777852800'],
    ['2026-12-31', 'after:1798675199 before:1798761600'],
    ['2026-01-01', 'after:1767225599 before:1767312000'],
  ])('translates %s', (name, expected) => {
    expect(dateDirToGmailQuery(name)).toBe(expected)
  })

  it.each([
    [''],
    ['2026-13-01'],
    ['2026-02-30'],
    ['2026-5-3'],
    ['2026'],
    ['not-a-date'],
    ['2026-05'],
    ['2026-05-03-extra'],
  ])('rejects %s', (name) => {
    expect(dateDirToGmailQuery(name)).toBeNull()
  })
})

describe('spanToGmailQuery', () => {
  it('bounds a half-open range in UTC seconds', () => {
    const query = spanToGmailQuery('2026-01-01', '2026-02-01')
    const [after, before] = query
      .split(' ')
      .map((term) => Number.parseInt(term.split(':')[1] ?? '', 10))
    expect((before ?? 0) * 1000).toBe(Date.UTC(2026, 1, 1))
    expect((before ?? 0) - (after ?? 0)).toBe(31 * 86_400 + 1)
  })
})
