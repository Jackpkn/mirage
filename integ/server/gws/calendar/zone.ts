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

import type { CalendarEvent, EventTime } from '../store/types.ts'

export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - instant
}

// A wall-clock reading resolved in `timeZone`, as an absolute instant.
// Two passes because the offset itself depends on the instant: on a DST
// boundary the first guess lands in the wrong offset and corrects on retry.
export function wallClockMs(naive: string, timeZone: string): number {
  const guess = Date.parse(`${naive}Z`)
  const once = guess - zoneOffsetMs(guess, timeZone)
  return guess - zoneOffsetMs(once, timeZone)
}

export function zonedMidnight(date: string, timeZone: string): number {
  return wallClockMs(`${date}T00:00:00`, timeZone)
}

// An offset is mandatory on dateTime UNLESS the slot names its own zone, so
// a bare wall clock here is a zoned event rather than an error. Date.parse
// would read it in the SERVER's local zone, which is neither.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/

export function slotMs(slot: EventTime, fallbackTz: string): number | null {
  if (slot.dateTime !== undefined) {
    if (HAS_OFFSET.test(slot.dateTime)) return Date.parse(slot.dateTime)
    return wallClockMs(slot.dateTime, slot.timeZone ?? fallbackTz)
  }
  if (slot.date !== undefined) return zonedMidnight(slot.date, fallbackTz)
  return null
}

export function eventStartMs(ev: CalendarEvent, tz: string): number {
  return slotMs(ev.start, tz) ?? 0
}

// An all-day event's end.date is EXCLUSIVE, so a single-day event spans
// start=D, end=D+1 and its instant end is midnight opening the next day.
export function eventEndMs(ev: CalendarEvent, tz: string): number {
  return slotMs(ev.end, tz) ?? eventStartMs(ev, tz)
}
