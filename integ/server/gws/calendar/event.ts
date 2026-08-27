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

import type { JsonValue, Reply } from '../../kit/typescript/index.ts'
import { PRIMARY_CALENDAR_ID } from '../store/state.ts'
import type { GwsState } from '../store/state.ts'
import type { CalendarEntry, CalendarEvent, EventTime } from '../store/types.ts'
import { asObj, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { ok } from '../wire/reply.ts'
import { eventEndMs, eventStartMs } from './zone.ts'

const DEFAULT_MAX_RESULTS = 250

export function calendarOr404(st: GwsState, id: string): CalendarEntry | null {
  const key = id === 'primary' ? PRIMARY_CALENDAR_ID : id
  return st.calendars.get(key) ?? null
}

export function eventsOf(st: GwsState, calendarId: string): Map<string, CalendarEvent> {
  let bucket = st.events.get(calendarId)
  if (bucket === undefined) {
    bucket = new Map()
    st.events.set(calendarId, bucket)
  }
  return bucket
}

export function fmtEvent(cal: CalendarEntry, ev: CalendarEvent): JsonObj {
  const out: JsonObj = {
    kind: 'calendar#event',
    id: ev.id,
    status: ev.status,
    start: { ...ev.start },
    end: { ...ev.end },
    created: ev.created,
    updated: ev.updated,
    iCalUID: `${ev.id}@google.com`,
    htmlLink: `https://www.google.com/calendar/event?eid=${ev.id}`,
  }
  // freeBusyReader sees availability only: no summary, description or
  // location ever reaches the caller, which is what makes a day directory
  // on such a calendar render opaque busy blocks.
  if (cal.accessRole !== 'freeBusyReader') {
    if (ev.summary !== undefined) out.summary = ev.summary
    if (ev.description !== undefined) out.description = ev.description
    if (ev.location !== undefined) out.location = ev.location
    if (ev.attendees !== undefined) out.attendees = ev.attendees
  }
  return out
}

export function matchesQ(ev: CalendarEvent, q: string): boolean {
  const needle = q.toLowerCase()
  const hay = [ev.summary, ev.description, ev.location].filter((v) => v !== undefined)
  return hay.some((v) => v.toLowerCase().includes(needle))
}

export function listCalendarEvents(
  st: GwsState,
  cal: CalendarEntry,
  query: URLSearchParams,
): Reply {
  const tz = query.get('timeZone') ?? cal.timeZone
  const showDeleted = query.get('showDeleted') === 'true'
  const q = query.get('q')
  const timeMin = query.get('timeMin')
  const timeMax = query.get('timeMax')
  let rows = [...eventsOf(st, cal.id).values()]
  if (!showDeleted) rows = rows.filter((ev) => ev.status !== 'cancelled')
  // timeMin is a lower bound on the event's END and timeMax an upper bound on
  // its START, both exclusive: the pair is an OVERLAP query, not containment,
  // so a multi-day or midnight-crossing event is returned by every day window
  // it touches.
  if (timeMin !== null) {
    const bound = Date.parse(timeMin)
    rows = rows.filter((ev) => eventEndMs(ev, cal.timeZone) > bound)
  }
  if (timeMax !== null) {
    const bound = Date.parse(timeMax)
    rows = rows.filter((ev) => eventStartMs(ev, cal.timeZone) < bound)
  }
  if (q !== null) rows = rows.filter((ev) => matchesQ(ev, q))
  if (query.get('orderBy') === 'startTime') {
    rows.sort((a, b) => eventStartMs(a, cal.timeZone) - eventStartMs(b, cal.timeZone))
  }
  const max = Number(query.get('maxResults') ?? String(DEFAULT_MAX_RESULTS))
  const start = Number(query.get('pageToken') ?? '0')
  const page = rows.slice(start, start + max)
  const out: JsonObj = {
    kind: 'calendar#events',
    summary: cal.summary,
    timeZone: tz,
    accessRole: cal.accessRole,
    items: page.map((ev) => fmtEvent(cal, ev)),
  }
  if (start + max < rows.length) out.nextPageToken = String(start + max)
  return ok(out)
}

function readSlot(
  raw: JsonValue | undefined,
  fallback: EventTime | undefined,
): EventTime | undefined {
  if (raw === undefined) return fallback
  const o = asObj(raw)
  const slot: EventTime = {}
  const date = asStr(o.date)
  const dateTime = asStr(o.dateTime)
  const timeZone = asStr(o.timeZone)
  if (date !== undefined) slot.date = date
  if (dateTime !== undefined) slot.dateTime = dateTime
  if (timeZone !== undefined) slot.timeZone = timeZone
  return slot
}

export function readEventTimes(
  body: JsonObj,
  fallback?: CalendarEvent,
): { start: EventTime; end: EventTime } | null {
  const start = readSlot(body.start, fallback?.start)
  const end = readSlot(body.end, fallback?.end)
  if (start === undefined || end === undefined) return null
  for (const t of [start, end]) {
    if (t.date === undefined && t.dateTime === undefined) return null
  }
  return { start, end }
}

export function makeEvent(st: GwsState, body: JsonObj): CalendarEvent | null {
  const times = readEventTimes(body)
  if (times === null) return null
  const now = st.now()
  const ev: CalendarEvent = {
    id: st.nextEventId(),
    status: 'confirmed',
    start: times.start,
    end: times.end,
    created: now,
    updated: now,
  }
  const summary = asStr(body.summary)
  const description = asStr(body.description)
  const location = asStr(body.location)
  if (summary !== undefined) ev.summary = summary
  if (description !== undefined) ev.description = description
  if (location !== undefined) ev.location = location
  if (body.attendees !== undefined) ev.attendees = body.attendees
  return ev
}
