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

import type { Clock, Minter } from '../../kit/typescript/index.ts'
import type {
  CalendarEntry,
  CalendarEvent,
  DocBody,
  DriveEntry,
  DriveItem,
  FormDoc,
  GmailLabel,
  GmailMessage,
  Presentation,
  Spreadsheet,
} from './types.ts'

export const SYSTEM_LABELS = ['INBOX', 'SENT', 'UNREAD', 'TRASH']

// Non-UTC on purpose: a UTC default would hide exactly the day-bucketing
// bugs this mock exists to catch. /reset can pin a different one.
export const DEFAULT_CALENDAR_TZ = 'Asia/Hong_Kong'
export const PRIMARY_CALENDAR_ID = 'integ@example.com'

export const ID_WIDTH = 4
export const EVENT_ID_WIDTH = 23

// One run's whole world. The kit keys one of these per run, so two runs
// served by the same process never advance each other's ids or clocks; the
// clock and the minter are the kit's, so gws no longer owns an epoch tick or
// a counter table of its own.
export class GwsState {
  files = new Map<string, DriveItem>()
  drives = new Map<string, DriveEntry>()
  docs = new Map<string, DocBody>()
  sheets = new Map<string, Spreadsheet>()
  presentations = new Map<string, Presentation>()
  messages = new Map<string, GmailMessage>()
  labels = new Map<string, GmailLabel>()
  calendars = new Map<string, CalendarEntry>()
  events = new Map<string, Map<string, CalendarEvent>>()
  forms = new Map<string, FormDoc>()
  readonly clock: Clock
  readonly minter: Minter

  constructor(clock: Clock, minter: Minter, calendarTz?: string) {
    this.clock = clock
    this.minter = minter
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: 'system' })
    this.calendars.set(PRIMARY_CALENDAR_ID, {
      id: PRIMARY_CALENDAR_ID,
      summary: 'Integ User',
      timeZone: calendarTz ?? DEFAULT_CALENDAR_TZ,
      accessRole: 'owner',
      primary: true,
    })
    this.events.set(PRIMARY_CALENDAR_ID, new Map())
  }

  // Zero-padded per kind, which is what every gws truth file already spells;
  // the kit's own `{kind}_new_{n}` format has no padding, so the width is
  // applied here rather than through Minter.mint.
  nextId(kind: string): string {
    return `${kind}${String(this.minter.next(kind)).padStart(ID_WIDTH, '0')}`
  }

  // Real Google event ids are 26 chars of base32hex (0-9a-v); filenames on a
  // gcal mount embed them, so the mock must produce the real shape, not a
  // short counter. Deterministic so integ truth files stay stable.
  nextEventId(): string {
    return `evt${String(this.minter.next('event')).padStart(EVENT_ID_WIDTH, '0')}`
  }

  nowMs(): number {
    return this.clock.nowMs()
  }

  now(): string {
    return this.clock.nowIso()
  }
}
