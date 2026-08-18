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
import { epochToIso, isoToEpoch, parseDateExpr, utcDateFolder } from './dates.ts'

describe('epochToIso', () => {
  it('formats whole seconds as second-precision ISO-Z', () => {
    expect(epochToIso(1609459200)).toBe('2021-01-01T00:00:00Z')
  })
  it('truncates sub-second input (parity with the Python converter)', () => {
    expect(epochToIso(1609459200.987)).toBe('2021-01-01T00:00:00Z')
  })
})

describe('isoToEpoch', () => {
  it('inverts epochToIso for a Z stamp', () => {
    expect(isoToEpoch('2021-01-01T00:00:00Z')).toBe(1609459200)
    expect(isoToEpoch('2026-01-02T15:30:45Z')).toBe(1767367845)
  })
  it('reads an offset-less (naive) stamp as UTC, not local', () => {
    expect(isoToEpoch('2026-01-02T15:30:45')).toBe(1767367845)
  })
  it('honors an explicit offset and truncates sub-seconds', () => {
    expect(isoToEpoch('2021-01-01T01:00:00+01:00')).toBe(1609459200)
    expect(isoToEpoch('2026-07-22T06:57:48.064802Z')).toBe(1784703468)
  })
  it('floors a negative fractional epoch (parity with Python)', () => {
    expect(isoToEpoch('1969-12-31T23:59:59.500Z')).toBe(-1)
    expect(epochToIso(-0.5)).toBe('1969-12-31T23:59:59Z')
  })
})

describe('utcDateFolder', () => {
  it('returns YYYY-MM-DD for a timestamp', () => {
    expect(utcDateFolder(1609459200000)).toBe('2021-01-01')
  })
})

describe('parseDateExpr', () => {
  const NOW = new Date(Date.UTC(2026, 7, 16, 13, 45, 30))

  it('parses relative displacements', () => {
    expect(parseDateExpr('24 hours ago', true, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 15, 13, 45, 30)),
    )
    expect(parseDateExpr('3 days', true, NOW)).toEqual(new Date(Date.UTC(2026, 7, 19, 13, 45, 30)))
    expect(parseDateExpr('-2 weeks', true, NOW)).toEqual(new Date(Date.UTC(2026, 7, 2, 13, 45, 30)))
    expect(parseDateExpr('2days', true, NOW)).toEqual(new Date(Date.UTC(2026, 7, 18, 13, 45, 30)))
  })

  it('parses word displacements', () => {
    expect(parseDateExpr('yesterday', true, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 15, 13, 45, 30)),
    )
    expect(parseDateExpr('tomorrow', true, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 17, 13, 45, 30)),
    )
    expect(parseDateExpr('now', true, NOW)).toEqual(NOW)
    expect(parseDateExpr('last year', true, NOW)).toEqual(
      new Date(Date.UTC(2025, 7, 16, 13, 45, 30)),
    )
    expect(parseDateExpr('next month', true, NOW)).toEqual(
      new Date(Date.UTC(2026, 8, 16, 13, 45, 30)),
    )
  })

  it('normalizes month overflow through the calendar like GNU', () => {
    expect(parseDateExpr('2026-01-31 1 month', true, NOW)).toEqual(new Date(Date.UTC(2026, 2, 3)))
  })

  it('parses an ISO base with a relative tail', () => {
    expect(parseDateExpr('2026-08-16 12:00:00 24 hours ago', true, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 15, 12, 0, 0)),
    )
  })

  it('parses @epoch and zone offsets', () => {
    expect(parseDateExpr('@1755300000', true)).toEqual(new Date(1755300000 * 1000))
    expect(parseDateExpr('2026-08-16T10:00:00+02:00', true)).toEqual(
      new Date(Date.UTC(2026, 7, 16, 8, 0, 0)),
    )
  })

  it('truncates fractional seconds instead of rounding into the next second', () => {
    expect(parseDateExpr('2026-01-01T00:00:00.9999Z', true)).toEqual(
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 999)),
    )
    expect(parseDateExpr('2026-01-01T00:00:00.5Z', true)).toEqual(
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500)),
    )
  })

  it('returns null for anything it cannot parse', () => {
    expect(parseDateExpr('not a date', true, NOW)).toBeNull()
    expect(parseDateExpr('24 hours agoo', true, NOW)).toBeNull()
    expect(parseDateExpr('', true, NOW)).toBeNull()
    expect(parseDateExpr('@abc', true, NOW)).toBeNull()
  })
})
