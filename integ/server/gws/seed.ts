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

import { createDriveItem } from './drive/item.ts'
import { eventsOf, makeEvent } from './calendar/event.ts'
import { DEFAULT_CALENDAR_TZ } from './store/state.ts'
import type { GwsState } from './store/state.ts'
import type { FormDoc } from './store/types.ts'
import { newFormItem } from './forms/form.ts'
import { asBool, asObjArr, asStr } from './wire/json.ts'
import type { JsonObj } from './wire/json.ts'
import { FORM_MIME } from './wire/mime.ts'

// A secondary calendar and a form carrying responses are both harness state
// rather than anything the API can mint: you own every calendar you create,
// so a reader one is by definition shared with you, and the Forms API has no
// method that submits a response at all. Both therefore ride /reset, the same
// out-of-band channel the pinned epoch already uses.
export function seedCalendars(st: GwsState, entries: JsonObj[]): void {
  for (const entry of entries) {
    const id = asStr(entry.id) ?? ''
    st.calendars.set(id, {
      id,
      summary: asStr(entry.summary) ?? '',
      timeZone: asStr(entry.timeZone) ?? DEFAULT_CALENDAR_TZ,
      accessRole: asStr(entry.accessRole) ?? 'owner',
      ...(asBool(entry.hidden) === true ? { hidden: true } : {}),
    })
    const bucket = eventsOf(st, id)
    for (const raw of asObjArr(entry.events)) {
      const ev = makeEvent(st, raw)
      if (ev === null) {
        throw new Error(`seed event needs a start and an end: ${JSON.stringify(raw)}`)
      }
      bucket.set(ev.id, ev)
    }
  }
}

export function seedForms(st: GwsState, entries: JsonObj[]): void {
  for (const entry of entries) {
    const title = asStr(entry.title) ?? ''
    const documentTitle = asStr(entry.documentTitle) ?? title
    const description = asStr(entry.description)
    // Through the Drive table for the same reason forms.create is: the
    // formId IS the Drive file id, and a seeded form has to be findable
    // the one way an agent can find one.
    const item = createDriveItem(
      st,
      documentTitle,
      FORM_MIME,
      [],
      Buffer.alloc(0),
      st.nextId('form'),
    )
    const form: FormDoc = {
      formId: item.id,
      title,
      documentTitle,
      ...(description === undefined ? {} : { description }),
      items: asObjArr(entry.items).map((raw) => newFormItem(st, raw)),
      responses: asObjArr(entry.responses),
      revision: 1,
    }
    st.forms.set(item.id, form)
  }
}
