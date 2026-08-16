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

export function utcDateFolder(ts?: number): string {
  const d = ts === undefined ? new Date() : new Date(ts)
  return d.toISOString().slice(0, 10)
}

// Truncated to whole seconds so this matches the Python epoch_to_iso byte
// for byte (second precision).
export function epochToIso(seconds: number): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace('.000Z', 'Z')
}

// Inverse of epochToIso; a naive stamp (no Z/offset, e.g. a `touch -t`
// overlay time) is read as UTC so this matches the Python isoToEpoch. JS
// interprets an offset-less date-time as local, so append Z when absent.
// Truncated to whole seconds to mirror epochToIso.
export function isoToEpoch(iso: string): number {
  const text = /(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`
  return Math.floor(Date.parse(text) / 1000)
}

// A date the user typed, as an epoch second, or null when it is not a date at
// all. Mirrors Python's isoTimestamp: an offset-less stamp is read as UTC and
// anything unparseable is null rather than NaN, so a caller can tell "not a
// date" from "the epoch".
export function isoTimestamp(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === '') return null
  const text = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : ms / 1000
}

const UNIT_SECONDS: Record<string, number> = {
  sec: 1,
  second: 1,
  min: 60,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
}
const CALENDAR_UNITS = new Set(['month', 'year'])
const NUMBER_UNIT_RE = /^([+-]?\d+)([a-z]+)$/
const NUMBER_RE = /^[+-]?\d+$/
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|z|[+-]\d{2}:?\d{2})?$/

function dateUnit(word: string): string | null {
  const unit = word !== 's' && word.endsWith('s') ? word.slice(0, -1) : word
  if (unit in UNIT_SECONDS || CALENDAR_UNITS.has(unit)) return unit
  return null
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  ms: number
}

function partsOf(dt: Date, utc: boolean): DateParts {
  return {
    year: utc ? dt.getUTCFullYear() : dt.getFullYear(),
    month: utc ? dt.getUTCMonth() : dt.getMonth(),
    day: utc ? dt.getUTCDate() : dt.getDate(),
    hour: utc ? dt.getUTCHours() : dt.getHours(),
    minute: utc ? dt.getUTCMinutes() : dt.getMinutes(),
    second: utc ? dt.getUTCSeconds() : dt.getSeconds(),
    ms: utc ? dt.getUTCMilliseconds() : dt.getMilliseconds(),
  }
}

function dateFrom(p: DateParts, utc: boolean): Date {
  if (utc) return new Date(Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second, p.ms))
  return new Date(p.year, p.month, p.day, p.hour, p.minute, p.second, p.ms)
}

function addMonthsGnu(dt: Date, count: number, utc: boolean): Date {
  const p = partsOf(dt, utc)
  const total = p.month + count
  let year = p.year + Math.floor(total / 12)
  let month = ((total % 12) + 12) % 12
  // GNU normalizes an overflowing day-of-month through mktime rather than
  // clamping: Jan 31 + 1 month is Mar 3, not Feb 28.
  let day = p.day
  const days = daysInMonth(year, month)
  if (day > days) {
    day -= days
    month += 1
    if (month === 12) {
      month = 0
      year += 1
    }
  }
  return dateFrom({ ...p, year, month, day }, utc)
}

function shiftDate(dt: Date, unit: string, count: number, utc: boolean): Date {
  if (unit === 'month') return addMonthsGnu(dt, count, utc)
  if (unit === 'year') return addMonthsGnu(dt, 12 * count, utc)
  return new Date(dt.getTime() + (UNIT_SECONDS[unit] ?? 0) * count * 1000)
}

function parseIsoWords(text: string, utc: boolean): Date | null {
  const m = ISO_RE.exec(text)
  if (m === null) return null
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const hour = m[4] !== undefined ? Number(m[4]) : 0
  const minute = m[5] !== undefined ? Number(m[5]) : 0
  const second = m[6] !== undefined ? Number(m[6]) : 0
  const ms = m[7] !== undefined ? Math.round(Number(`0.${m[7]}`) * 1000) : 0
  const zone = m[8]
  if (zone !== undefined) {
    let offsetMin = 0
    if (zone !== 'Z' && zone !== 'z') {
      const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
      if (zm === null) return null
      offsetMin = (zm[1] === '-' ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3]))
    }
    return new Date(Date.UTC(year, month, day, hour, minute, second, ms) - offsetMin * 60_000)
  }
  return dateFrom({ year, month, day, hour, minute, second, ms }, utc)
}

function applyRelative(base: Date, words: string[], utc: boolean): Date | null {
  let result = base
  // What `ago` would negate: the state before the last displacement plus
  // that displacement. Re-applying from the checkpoint (rather than
  // subtracting twice) keeps month normalization exact.
  let checkpoint: [Date, string, number] | null = null
  let i = 0
  while (i < words.length) {
    let word = (words[i] ?? '').toLowerCase()
    if (word === 'now' || word === 'today') {
      checkpoint = null
      i += 1
      continue
    }
    if (word === 'yesterday' || word === 'tomorrow') {
      const days = word === 'yesterday' ? -1 : 1
      checkpoint = [result, 'day', days]
      result = shiftDate(result, 'day', days, utc)
      i += 1
      continue
    }
    if (word === 'last' || word === 'next') {
      const unit = i + 1 < words.length ? dateUnit((words[i + 1] ?? '').toLowerCase()) : null
      if (unit === null) return null
      const count = word === 'last' ? -1 : 1
      checkpoint = [result, unit, count]
      result = shiftDate(result, unit, count, utc)
      i += 2
      continue
    }
    if (word === 'ago') {
      if (checkpoint === null) return null
      const [before, unit, count] = checkpoint
      result = shiftDate(before, unit, -count, utc)
      checkpoint = null
      i += 1
      continue
    }
    let sign = 1
    if (word === '+' || word === '-') {
      sign = word === '-' ? -1 : 1
      i += 1
      if (i >= words.length) return null
      word = (words[i] ?? '').toLowerCase()
    }
    const combined = NUMBER_UNIT_RE.exec(word)
    if (combined !== null) {
      const unit = dateUnit(combined[2] ?? '')
      if (unit === null) return null
      const count = Number(combined[1]) * sign
      checkpoint = [result, unit, count]
      result = shiftDate(result, unit, count, utc)
      i += 1
      continue
    }
    if (NUMBER_RE.test(word)) {
      const unit = i + 1 < words.length ? dateUnit((words[i + 1] ?? '').toLowerCase()) : null
      if (unit === null) return null
      const count = Number(word) * sign
      checkpoint = [result, unit, count]
      result = shiftDate(result, unit, count, utc)
      i += 2
      continue
    }
    const unit = dateUnit(word)
    if (unit !== null) {
      checkpoint = [result, unit, sign]
      result = shiftDate(result, unit, sign, utc)
      i += 1
      continue
    }
    return null
  }
  return result
}

// Parse a GNU `date -d` expression, or null when it is invalid. Covers the
// forms agents actually type: ISO 8601 dates and datetimes (with or without
// zone), `@epoch`, and gnulib's relative grammar (`24 hours ago`,
// `yesterday`, `next month`, `-2 weeks`, an ISO date followed by
// displacements). A null return is the caller's cue for GNU's
// `date: invalid date '...'` refusal, never a NaN render. Mirrors the
// Python parse_date_expr.
export function parseDateExpr(text: string, utc: boolean, now?: Date): Date | null {
  const raw = text.trim()
  if (raw === '') return null
  if (raw.startsWith('@')) {
    const epoch = Number(raw.slice(1))
    if (Number.isNaN(epoch)) return null
    return new Date(epoch * 1000)
  }
  const whole = parseIsoWords(raw, utc)
  if (whole !== null) return whole
  const words = raw.split(/\s+/)
  let base = now ?? new Date()
  let index = 0
  for (const take of [2, 1]) {
    if (words.length < take) continue
    const prefix = parseIsoWords(words.slice(0, take).join(' '), utc)
    if (prefix === null) continue
    base = prefix
    index = take
    break
  }
  return applyRelative(base, words.slice(index), utc)
}
